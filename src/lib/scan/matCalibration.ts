/**
 * Direct port of DimensionScanner/MatCalibrationEngine.swift's `evaluate`,
 * adapted for a single static uploaded frame rather than a live tracked
 * stream — the burst/`markerPhase == .stable` gate from the original
 * doesn't apply here (there's no "wait for N stable frames" concept
 * server-side; whatever markers were detected in the one uploaded frame are
 * used directly).
 *
 * Two-stage fit:
 *   1. Preliminary homography from the four marker CENTERS (each detected
 *      center is the intersection of its quad's diagonals — the
 *      projectively-correct image of the physical square's center).
 *   2. The preliminary fit projects each QR's known physical corners into
 *      the image; detected corners are matched to them by testing all
 *      cyclic rotations and both windings, keeping the assignment with the
 *      smallest total squared error. The final homography is a
 *      least-squares fit over all 16 matched corners.
 */
import {
  MAT_CORNERS,
  polygonOrder,
  qrMarkers,
  type MatCorner,
} from "./matGeometry";
import { fitHomography, projectMatPoint, type Homography, type Pt } from "./homography";

// --- Config (MatCalibrationConfig.prototype, ported 1:1) ----------------

export const CALIBRATION_CONFIG = {
  requiredMarkerCount: 4,
  /**
   * RMS of the 16-corner reprojection residuals, in RGB pixels.
   *
   * 3.0/8.0 (the original values) were tuned for when this homography fed
   * the actual mm math directly (the old on-device/segmentation pipeline).
   * Now it's only a pre-flight "is the mat plausibly in frame and legible"
   * gate before handing the raw photo to Gemini (gemini.ts) — Gemini reads
   * the mat's printed ruler itself, it never consumes this homography, so
   * sub-mm precision here no longer matters. A real printed sheet that
   * isn't laser-flat routinely produces ~4-6px of evenly-spread residual
   * from harmless paper warp alone (confirmed against a real rejected
   * photo: 4.22px RMS / 6.26px peak, spread evenly across all 16 corners —
   * not a bad photo, just imperfectly flat paper), which the old strict
   * threshold rejected for no remaining reason. Widened with real margin
   * above that measurement; still tight enough to catch a genuinely bad
   * photo (severe blur, folded mat, mostly out of frame), which produces
   * errors well beyond this.
   */
  maxRMSReprojectionErrorPixels: 6.0,
  /** Worst single-corner reprojection residual, in RGB pixels. */
  maxPeakReprojectionErrorPixels: 12.0,
  /** Minimum fraction of the RGB image the marker-center quadrilateral must cover. */
  minMarkerQuadAreaFraction: 0.06,
  /** Minimum ratio between opposite sides of the marker-center quadrilateral. */
  minOppositeSideRatio: 0.6,
} as const;

export interface DetectedMarker {
  corner: MatCorner;
  /** Quad corners in image pixels, cyclic order (as detected). */
  corners: Pt[];
}

export type CalibrationFailureReason =
  | "missing_markers"
  | "inconsistent_marker_ordering"
  | "degenerate_geometry"
  | "mat_too_small_in_image"
  | "excessive_tilt"
  | "reprojection_error_too_high"
  | "mat_geometry_unavailable";

export type CalibrationOutcome =
  | {
      ok: true;
      homography: Homography;
      rmsReprojectionErrorPixels: number;
      maximumReprojectionErrorPixels: number;
      correspondenceCount: number;
    }
  | { ok: false; reason: CalibrationFailureReason };

/** Intersection of the quad's diagonals (p0-p2 and p1-p3). */
function diagonalIntersection(quad: Pt[]): Pt | null {
  if (quad.length !== 4) return null;
  const d1 = { x: quad[2].x - quad[0].x, y: quad[2].y - quad[0].y };
  const d2 = { x: quad[3].x - quad[1].x, y: quad[3].y - quad[1].y };
  const r = { x: quad[1].x - quad[0].x, y: quad[1].y - quad[0].y };
  const denominator = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denominator) <= 1e-12) return null;
  const t = (r.x * d2.y - r.y * d2.x) / denominator;
  if (!Number.isFinite(t)) return null;
  return { x: quad[0].x + t * d1.x, y: quad[0].y + t * d1.y };
}

/** Shoelace signed area (image convention: +Y down). */
function signedArea(polygon: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * True when the TL -> TR -> BR -> BL quadrilateral is convex with the
 * winding a front-viewed (non-mirrored) mat always produces in top-left-
 * origin image coordinates: positive shoelace sign at every vertex.
 */
function isConvexWithExpectedWinding(quad: Pt[]): boolean {
  if (quad.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(cross > 1e-9)) return false;
  }
  return true;
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** min/max length ratio across the two opposite-side pairs of the TL->TR->BR->BL quad. */
function oppositeSideRatio(quad: Pt[]): number {
  if (quad.length !== 4) return 0;
  const top = distance(quad[0], quad[1]);
  const right = distance(quad[1], quad[2]);
  const bottom = distance(quad[2], quad[3]);
  const left = distance(quad[3], quad[0]);
  if (top <= 0 || right <= 0 || bottom <= 0 || left <= 0) return 0;
  const horizontal = Math.min(top, bottom) / Math.max(top, bottom);
  const vertical = Math.min(left, right) / Math.max(left, right);
  return Math.min(horizontal, vertical);
}

/**
 * Matches detected quad corners to projected physical corners by testing the
 * four cyclic rotations in both windings; returns the detected corners
 * reordered to correspond index-by-index with the projected ones.
 */
function bestCornerAssignment(detected: Pt[], projected: Pt[]): Pt[] | null {
  if (detected.length !== 4 || projected.length !== 4) return null;
  let best: Pt[] | null = null;
  let bestError = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    for (const direction of [1, -1]) {
      const candidate: Pt[] = [];
      let error = 0;
      for (let index = 0; index < 4; index++) {
        const detectedIndex = (((shift + direction * index) % 4) + 4) % 4;
        const point = detected[detectedIndex];
        candidate.push(point);
        const dx = point.x - projected[index].x;
        const dy = point.y - projected[index].y;
        error += dx * dx + dy * dy;
      }
      if (error < bestError) {
        bestError = error;
        best = candidate;
      }
    }
  }
  return best;
}

export function calibrate(
  markers: DetectedMarker[],
  imagePixelSize: { width: number; height: number },
): CalibrationOutcome {
  if (imagePixelSize.width <= 1 || imagePixelSize.height <= 1) {
    return { ok: false, reason: "degenerate_geometry" };
  }
  if (markers.length < CALIBRATION_CONFIG.requiredMarkerCount) {
    return { ok: false, reason: "missing_markers" };
  }

  const byCorner = new Map(markers.map((m) => [m.corner, m]));

  const detectedQuads = new Map<MatCorner, Pt[]>();
  const detectedCenters = new Map<MatCorner, Pt>();
  for (const corner of MAT_CORNERS) {
    const tracked = byCorner.get(corner);
    if (!tracked || tracked.corners.length !== 4) {
      return { ok: false, reason: "missing_markers" };
    }
    const center = diagonalIntersection(tracked.corners);
    if (!center) return { ok: false, reason: "inconsistent_marker_ordering" };
    detectedQuads.set(corner, tracked.corners);
    detectedCenters.set(corner, center);
  }

  const centerQuad = polygonOrder.map((c) => detectedCenters.get(c)!);
  if (centerQuad.some((p) => p === undefined)) return { ok: false, reason: "missing_markers" };

  if (!isConvexWithExpectedWinding(centerQuad)) {
    return { ok: false, reason: "inconsistent_marker_ordering" };
  }

  const quadArea = Math.abs(signedArea(centerQuad));
  const imageArea = imagePixelSize.width * imagePixelSize.height;
  if (quadArea / imageArea < CALIBRATION_CONFIG.minMarkerQuadAreaFraction) {
    return { ok: false, reason: "mat_too_small_in_image" };
  }

  if (oppositeSideRatio(centerQuad) < CALIBRATION_CONFIG.minOppositeSideRatio) {
    return { ok: false, reason: "excessive_tilt" };
  }

  // Stage 1: preliminary homography from the four marker centers.
  const centerPairs: { mat: Pt; image: Pt }[] = [];
  for (const corner of MAT_CORNERS) {
    const marker = qrMarkers[corner];
    const detected = detectedCenters.get(corner);
    if (!marker || !detected) return { ok: false, reason: "mat_geometry_unavailable" };
    centerPairs.push({ mat: marker.center, image: detected });
  }
  const preliminary = fitHomography(centerPairs, imagePixelSize);
  if (!preliminary) return { ok: false, reason: "degenerate_geometry" };

  // Stage 2: match each QR's detected corners to its projected physical
  // corners, then fit over all 16 correspondences.
  const cornerPairs: { mat: Pt; image: Pt }[] = [];
  for (const corner of MAT_CORNERS) {
    const marker = qrMarkers[corner];
    const detectedQuad = detectedQuads.get(corner);
    if (!marker || !detectedQuad) return { ok: false, reason: "mat_geometry_unavailable" };

    const projected: Pt[] = [];
    for (const physicalCorner of marker.corners) {
      const point = projectMatPoint(preliminary, physicalCorner);
      if (!point) return { ok: false, reason: "degenerate_geometry" };
      projected.push(point);
    }

    const assignment = bestCornerAssignment(detectedQuad, projected);
    if (!assignment) return { ok: false, reason: "inconsistent_marker_ordering" };

    marker.corners.forEach((physicalCorner, index) => {
      cornerPairs.push({ mat: physicalCorner, image: assignment[index] });
    });
  }

  const homography = fitHomography(cornerPairs, imagePixelSize);
  if (!homography) return { ok: false, reason: "degenerate_geometry" };

  // Reprojection residuals over the final 16-point fit.
  let sumSquared = 0;
  let maximum = 0;
  for (const { mat, image } of cornerPairs) {
    const reprojected = projectMatPoint(homography, mat);
    if (!reprojected) return { ok: false, reason: "degenerate_geometry" };
    const dx = reprojected.x - image.x;
    const dy = reprojected.y - image.y;
    const squared = dx * dx + dy * dy;
    sumSquared += squared;
    maximum = Math.max(maximum, Math.sqrt(squared));
  }
  const rms = Math.sqrt(sumSquared / cornerPairs.length);

  if (
    rms > CALIBRATION_CONFIG.maxRMSReprojectionErrorPixels ||
    maximum > CALIBRATION_CONFIG.maxPeakReprojectionErrorPixels
  ) {
    return { ok: false, reason: "reprojection_error_too_high" };
  }

  return {
    ok: true,
    homography,
    rmsReprojectionErrorPixels: rms,
    maximumReprojectionErrorPixels: maximum,
    correspondenceCount: cornerPairs.length,
  };
}
