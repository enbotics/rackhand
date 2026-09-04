/**
 * QR marker detection via `zedbar` (a maintained Rust/WASM port of ZBar).
 *
 * Replaces an earlier `jsqr`-based implementation that needed a manual
 * 4-corner-crop workaround (jsQR only finds one symbol per call). `zedbar`
 * finds every symbol in the image in a single call, so the happy path here
 * is just one full-resolution scan.
 *
 * A real captured photo still measurably defeated the full-resolution pass
 * on 2 of 4 markers — confirmed by testing zedbar directly against isolated
 * crops of each marker, with `retryUndecodedRegions` on. Direct
 * experimentation on that same photo showed one of those two is rescuable
 * with a targeted crop + upscale of just that region (the QR was legible,
 * just too small at native resolution for the decoder's own retry
 * heuristics); the other showed genuine motion/defocus blur even upscaled,
 * which no amount of upscaling can fix — a real capture-quality floor, not a
 * decoder limitation.
 *
 * A SINGLE fixed upscale factor is not robust, confirmed directly against 3
 * real photos: the scale that rescues a given marker depends on how large
 * the QR was in the original frame (how close the phone was held), and that
 * varies per photo and even per marker within the same photo. A hardcoded
 * 4x, for instance, decoded one photo's markers fine but missed a marker in
 * a different photo that only decoded at 1.5x — while 1.5x alone decoded
 * every rescuable marker across all 3 test photos. So the fallback sweeps a
 * short list of scales per crop window, stopping at the first that decodes,
 * rather than betting on one number.
 *
 * The upscale step MUST use a real interpolating resize, not
 * nearest-neighbor — verified directly: a hand-rolled nearest-neighbor
 * upscale of the exact same crop failed to decode, while `sharp`'s default
 * (Lanczos-quality) resize of that identical crop succeeded. That's why
 * this module pulls in `sharp` and is async, unlike the rest of lib/scan/.
 *
 * Strategy: full-image pass first (cheap, catches the easy markers), then a
 * 4-corner-crop-and-upscale fallback ONLY for whatever's still missing,
 * since blindly upscaling markers that already decoded fine at native
 * resolution measurably breaks them (verified: the whole image upscaled 2x
 * lost a marker the native-resolution pass had already found).
 */
import sharp from "sharp";
import { scanGrayscale, ScanOptions } from "zedbar";
import { cornerFromPayload, type MatCorner } from "./matGeometry";
import type { DetectedMarker } from "./matCalibration";
import type { Pt } from "./homography";

export interface RGBAImage {
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** BT.601 luma — same convention already used in rectify.ts's deriveYCbCr. */
function toGrayscale(data: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const count = width * height;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * 4;
    out[i] = Math.round(0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2]);
  }
  return out;
}

const SCAN_OPTIONS = (() => {
  const options = new ScanOptions();
  options.symbologies = ["QR-Code"];
  options.retryUndecodedRegions = true;
  return options;
})();

/**
 * Runs one scan pass over `grayscale` and merges newly-decoded, not-yet-
 * found corners into `found`. `toFullImage` maps a point in this pass's
 * (possibly cropped/upscaled) buffer coordinates back to full-image pixel
 * coordinates — identity for the native full-image pass, or
 * scale-then-translate for a cropped/upscaled fallback pass.
 */
function scanAndMerge(
  found: Map<MatCorner, Pt[]>,
  grayscale: Uint8Array,
  width: number,
  height: number,
  toFullImage: (p: Pt) => Pt,
): void {
  const results = scanGrayscale(grayscale, width, height, SCAN_OPTIONS);
  for (const result of results) {
    if (!result.text) continue;
    const corner = cornerFromPayload(result.text);
    if (!corner || found.has(corner)) continue;
    // For QR codes this is documented as exactly the 4 corner points of the
    // symbol's bounding rectangle, order implementation-defined —
    // `matCalibration.ts`'s bestCornerAssignment already tries every cyclic
    // rotation and both windings, so an arbitrary starting order/winding
    // here is fine.
    if (result.points.length < 4) continue;
    found.set(corner, result.points.slice(0, 4).map((p) => toFullImage({ x: p.x, y: p.y })));
  }
}

const FALLBACK_CROP_FRACTION = 0.6;
/** Tried in order per crop window, stopping at the first scale that decodes anything new — see module doc for why a single fixed scale isn't robust. */
const FALLBACK_SCALES = [1.5, 1, 2, 3, 4, 6];

/** Crops one image corner out of the full-image RGBA and upscales it via a real interpolating resize (see module doc — nearest-neighbor measurably fails here). */
async function croppedGrayscaleUpscaled(
  data: Uint8ClampedArray | Uint8Array,
  imageWidth: number,
  imageHeight: number,
  x0: number,
  y0: number,
  cropW: number,
  cropH: number,
  scale: number,
): Promise<{ grayscale: Uint8Array; width: number; height: number }> {
  const rgba = sharp(Buffer.from(data), { raw: { width: imageWidth, height: imageHeight, channels: 4 } });
  const { data: upscaledRGBA, info } = await rgba
    .extract({ left: x0, top: y0, width: cropW, height: cropH })
    .resize(Math.round(cropW * scale), Math.round(cropH * scale))
    .raw()
    .toBuffer({ resolveWithObject: true });

  const grayscale = new Uint8Array(info.width * info.height);
  for (let i = 0; i < grayscale.length; i++) {
    const base = i * info.channels;
    grayscale[i] = Math.round(
      0.299 * upscaledRGBA[base] + 0.587 * upscaledRGBA[base + 1] + 0.114 * upscaledRGBA[base + 2],
    );
  }
  return { grayscale, width: info.width, height: info.height };
}

export async function detectMarkers(image: RGBAImage, matId: string): Promise<DetectedMarker[]> {
  const { data, width, height } = image;
  const found = new Map<MatCorner, Pt[]>();

  // Pass 1: full image, native resolution — cheap, catches every marker
  // that's a reasonable size and sharpness.
  scanAndMerge(found, toGrayscale(data, width, height), width, height, (p) => p);

  // Pass 2: only if something is still missing. Crop each of the 4 image
  // corners and upscale aggressively — rescues markers that are legible but
  // too small/subtle for the decoder's own retry heuristics at native
  // resolution. Never re-touches an already-found corner (scanAndMerge
  // skips it via found.has()), so this can't regress a marker pass 1
  // already got right, even though upscaling an already-easy marker can
  // itself break it.
  if (found.size < 4) {
    const cropW = Math.round(width * FALLBACK_CROP_FRACTION);
    const cropH = Math.round(height * FALLBACK_CROP_FRACTION);
    const windows = [
      { x0: 0, y0: 0 },
      { x0: width - cropW, y0: 0 },
      { x0: 0, y0: height - cropH },
      { x0: width - cropW, y0: height - cropH },
    ];

    for (const { x0, y0 } of windows) {
      if (found.size >= 4) break;
      const sizeBeforeWindow = found.size;

      for (const scale of FALLBACK_SCALES) {
        if (found.size >= 4) break;

        const { grayscale, width: upW, height: upH } = await croppedGrayscaleUpscaled(
          data,
          width,
          height,
          x0,
          y0,
          cropW,
          cropH,
          scale,
        );
        scanAndMerge(found, grayscale, upW, upH, (p) => ({
          x: x0 + p.x / scale,
          y: y0 + p.y / scale,
        }));

        // This window decoded something new — no reason to keep trying
        // other scales on it (and re-trying at a worse scale can only waste
        // time, never help, since scanAndMerge already skips found corners).
        if (found.size > sizeBeforeWindow) break;
      }
    }
  }

  return Array.from(found.entries()).map(([corner, corners]) => ({ corner, corners }));
}
