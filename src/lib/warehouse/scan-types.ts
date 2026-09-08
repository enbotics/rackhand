/**
 * The warehouse-facing contract for one physical scan of one spare part.
 *
 * A `ScanResult` is what everything downstream of the camera will consume
 * (Milestone 2+: Strands warehouse agent -> catalog matching -> inventory ->
 * gantry). Milestone 1 stops here: producing one.
 *
 * It deliberately carries NO warehouse identity — no `sku`, `partId`,
 * `catalogId`, `binId`, `inventoryId`. `object.detectedName` is a
 * vision-derived candidate label from Gemini, never an authoritative catalog
 * name; resolving it against a catalog is a later milestone's job.
 *
 * Types only, no runtime code and no server-only imports, so this module is
 * safe to import from the route handler and from the browser components
 * alike — the measurement shape stays defined exactly once for both sides.
 */

/**
 * The existing measurement pipeline's output — the JSON body of
 * `POST /api/measure` (see app/api/measure/route.ts), which is also the
 * measured half of the persisted `Measurement` record in lib/shots-db.ts.
 *
 * This is the input side of the ScanResult conversion. It is intentionally
 * the pipeline's own vocabulary (`name`, flat mm fields) rather than the
 * warehouse's — measurementToScanResult is what translates between them.
 */
export interface MeasurementResult {
  /** Gemini's candidate label for the object. Not a catalog identity. */
  name: string;
  description: string;
  /** Longer in-plane side, from the mat homography (lib/matMeasurement.ts). */
  lengthMM: number;
  /** Shorter in-plane side, from the mat homography. */
  widthMM: number;
  /** Gemini's best-effort height, or null when it could not form one. */
  heightMM: number | null;
  /** Rotation of the long side relative to the mat's bottom edge. */
  angleDegrees: number;
  /** 0-1 — how tightly Gemini's rectangle fits the object. */
  dimensionConfidence: number;
  /** Reprojection RMS (pixels) of the mat's 4-QR homography fit. */
  calibrationRmsPixels: number;
  /** Gemini's visible count of matching units; absent only on legacy saved scans. */
  observedQuantity?: number;
  /** 0-1 confidence that the visible matching-unit count is complete. */
  quantityConfidence?: number;
}

/** What the camera saw. A candidate description, not an identity. */
export interface ScanObject {
  /** Vision-derived candidate name. Milestone 2 resolves this to a catalog part. */
  detectedName: string;
  description: string;
}

/** Real-world size in millimetres. */
export interface ScanDimensions {
  lengthMM: number;
  widthMM: number;
  /** null when height could not be estimated from a single overhead frame. */
  heightMM: number | null;
}

/** How much to trust this scan's numbers. */
export interface ScanQuality {
  /** 0-1, Gemini's bounding-rectangle fit confidence. */
  dimensionConfidence: number;
  /** >= 0, the mat calibration's reprojection RMS in pixels. */
  calibrationRmsPixels: number;
}

/** How the part was lying on the mat. */
export interface ScanOrientation {
  angleDegrees: number;
}

/** The result of physically scanning one spare part. */
export interface ScanResult {
  /** `scan_<capturedAt>_<random>` — unique per scan, not a part identity. */
  scanId: string;
  /** Epoch ms of the capture the scan came from (Shot.createdAt). */
  capturedAt: number;
  object: ScanObject;
  dimensions: ScanDimensions;
  quality: ScanQuality;
  orientation: ScanOrientation;
  /** Visual evidence only. Warehouse services validate and apply this count. */
  quantity?: { observed: number; confidence: number };
}

/** Capture-side metadata the measurement itself does not carry. */
export interface ScanCaptureMeta {
  /** Epoch ms the frame was captured — not when it was measured. */
  capturedAt: number;
  /** Optional pre-generated id, so callers/tests can keep the conversion deterministic. */
  scanId?: string;
}

/**
 * Conversion outcome. Failures list every rejected field rather than
 * collapsing into one opaque message, matching how /api/measure keeps its
 * own failure reasons distinct.
 */
export type ScanConversion =
  | { ok: true; scanResult: ScanResult }
  | { ok: false; issues: string[] };
