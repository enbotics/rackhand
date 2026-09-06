import { NextResponse } from "next/server";
import sharp from "sharp";
import { measureWithGemini } from "@/lib/geminiMeasure";
import { measureFromMatHomography } from "@/lib/matMeasurement";
import { detectMarkers } from "@/lib/scan/qrDetector";
import { calibrate } from "@/lib/scan/matCalibration";
import { MAT_ID } from "@/lib/scan/matGeometry";
import type { MeasurementResult } from "@/lib/warehouse/scan-types";

/**
 * POST /api/measure — takes one captured shot (with the printed calibration
 * mat visible in frame), returns a measured object: name, description,
 * length/width in mm, and a best-effort height.
 *
 * Two stages, same split as parts-layout-planner's pipeline:
 *  1. Deterministic QR detection + homography fit (lib/scan/matCalibration.ts,
 *     ported unchanged) — a cheap, real geometric check that the mat is
 *     actually in frame and legible, BEFORE spending a Gemini call. Its
 *     homography is also what does the actual pixel->mm conversion, not
 *     just a pre-flight gate here (see lib/matMeasurement.ts).
 *  2. Gemini locates the physical object's corners (never estimates any
 *     mm value itself) — see lib/geminiMeasure.ts.
 *
 * Runs server-side only so GEMINI_API_KEY never reaches the browser.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MeasureRequestBody {
  imageDataUrl?: string;
  imageWidthPx?: number;
  imageHeightPx?: number;
}

type ErrorCode =
  | "malformed_request"
  | "validation_failed"
  | "mat_not_detected"
  | "calibration_failed"
  | "no_object_detected"
  | "multiple_objects"
  | "internal_error";

function fail(status: number, code: ErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  let body: MeasureRequestBody;
  try {
    body = await request.json();
  } catch {
    return fail(400, "malformed_request", "Body is not parseable JSON.");
  }

  const { imageDataUrl, imageWidthPx, imageHeightPx } = body;

  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return fail(422, "validation_failed", "imageDataUrl must be a data: image URL.");
  }
  if (!Number.isInteger(imageWidthPx) || !Number.isInteger(imageHeightPx) || imageWidthPx! <= 0 || imageHeightPx! <= 0) {
    return fail(422, "validation_failed", "imageWidthPx/imageHeightPx must be positive integers.");
  }

  const base64 = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  const imageBuffer = Buffer.from(base64, "base64");

  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const markers = await detectMarkers({ data, width: info.width, height: info.height }, MAT_ID);
  const calibration = calibrate(markers, { width: info.width, height: info.height });
  if (!calibration.ok) {
    return calibration.reason === "missing_markers"
      ? fail(422, "mat_not_detected", "Calibration mat not detected — make sure all 4 corner QR codes are visible and the mat is flat.")
      : fail(422, "calibration_failed", `Calibration mat detected but the fit failed (${calibration.reason}) — try a clearer, flatter shot.`);
  }

  let outcome;
  try {
    outcome = await measureWithGemini(imageBuffer);
  } catch (err) {
    console.error("[measure] Gemini call failed:", err);
    return fail(500, "internal_error", "Could not reach Gemini.");
  }

  if (!outcome.ok) {
    return fail(
      422,
      outcome.reason,
      outcome.reason === "multiple_objects"
        ? "More than one object is visible — measure one at a time."
        : "No object detected on the mat.",
    );
  }

  const measurement = measureFromMatHomography(
    outcome.measurement.corners,
    imageWidthPx!,
    imageHeightPx!,
    calibration.homography,
  );
  if (!measurement) {
    return fail(500, "internal_error", "Could not convert the object's corners to real-world mm.");
  }

  // Typed against the shared contract (lib/warehouse/scan-types.ts) that the
  // client and the ScanResult conversion both read, so the two sides cannot
  // drift. The response shape itself is unchanged.
  const response: MeasurementResult = {
    name: outcome.measurement.name,
    description: outcome.measurement.description,
    lengthMM: measurement.lengthMM,
    widthMM: measurement.widthMM,
    heightMM: outcome.measurement.heightMM,
    angleDegrees: measurement.angleDegrees,
    dimensionConfidence: outcome.measurement.dimensionConfidence,
    calibrationRmsPixels: calibration.rmsReprojectionErrorPixels,
  };

  return NextResponse.json(response);
}
