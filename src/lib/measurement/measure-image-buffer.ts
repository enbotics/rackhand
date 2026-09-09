import sharp from "sharp";

import { measureWithGemini } from "@/lib/geminiMeasure";
import { measureFromMatHomography } from "@/lib/matMeasurement";
import { detectMarkers } from "@/lib/scan/qrDetector";
import { calibrate } from "@/lib/scan/matCalibration";
import { MAT_ID } from "@/lib/scan/matGeometry";

import type { MeasurementResult } from "@/lib/warehouse/scan-types";

export type MeasurementErrorCode =
  | "validation_failed"
  | "mat_not_detected"
  | "calibration_failed"
  | "no_object_detected"
  | "multiple_objects"
  | "internal_error";

export class MeasurementError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MeasurementErrorCode,
    message: string,
  ) {
    super(message);

    this.name = "MeasurementError";
  }
}

export function isMeasurementError(error: unknown): error is MeasurementError {
  return error instanceof MeasurementError;
}

/**
 * Shared server-side measurement pipeline.
 *
 * Used by:
 * - Raspberry Pi camera jobs
 * - future audit/recount capture flows
 *
 * Important architecture:
 *
 * Gemini:
 *   identifies/localizes the physical object
 *
 * Deterministic code:
 *   detects calibration markers
 *   builds the homography
 *   converts image-space object corners into millimetres
 *
 * Never trust request-supplied image dimensions. The decoded image itself
 * is authoritative.
 */
export async function measureImageBuffer(
  imageBuffer: Buffer,
): Promise<MeasurementResult> {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new MeasurementError(422, "validation_failed", "Image is empty.");
  }

  /*
   * Decode once for deterministic marker detection.
   *
   * info.width/info.height are the authoritative dimensions of the actual
   * uploaded image.
   */
  let rawImage: Buffer;
  let imageWidthPx: number;
  let imageHeightPx: number;

  try {
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({
        resolveWithObject: true,
      });

    if (
      !Number.isInteger(info.width) ||
      !Number.isInteger(info.height) ||
      info.width <= 0 ||
      info.height <= 0
    ) {
      throw new Error("Decoded image has invalid dimensions.");
    }

    rawImage = data;
    imageWidthPx = info.width;
    imageHeightPx = info.height;
  } catch (error) {
    console.error("[measure] Failed to decode image:", error);

    throw new MeasurementError(
      422,
      "validation_failed",
      "Uploaded image could not be decoded.",
    );
  }

  /*
   * Stage 1:
   * deterministic QR / calibration marker detection.
   */
  let markers;

  try {
    markers = await detectMarkers(
      {
        data: rawImage,
        width: imageWidthPx,
        height: imageHeightPx,
      },
      MAT_ID,
    );
  } catch (error) {
    console.error("[measure] Calibration marker detection failed:", error);

    throw new MeasurementError(
      500,
      "internal_error",
      "Calibration marker detection failed.",
    );
  }

  /*
   * Stage 2:
   * calculate image -> mat millimetre homography.
   */
  const calibration = calibrate(markers, {
    width: imageWidthPx,
    height: imageHeightPx,
  });

  if (!calibration.ok) {
    if (calibration.reason === "missing_markers") {
      throw new MeasurementError(
        422,
        "mat_not_detected",
        "Calibration mat not detected — make sure all 4 corner QR codes are visible and the mat is flat.",
      );
    }

    throw new MeasurementError(
      422,
      "calibration_failed",
      `Calibration mat detected but the fit failed (${calibration.reason}) — try a clearer, flatter shot.`,
    );
  }

  /*
   * Stage 3:
   * Gemini identifies/localizes the object.
   *
   * Gemini does NOT calculate authoritative L/W values.
   */
  let outcome;

  try {
    outcome = await measureWithGemini(imageBuffer);
  } catch (error) {
    console.error("[measure] Gemini call failed:", error);

    throw new MeasurementError(
      500,
      "internal_error",
      "Could not reach Gemini.",
    );
  }

  if (!outcome.ok) {
    if (outcome.reason === "multiple_objects") {
      throw new MeasurementError(
        422,
        "multiple_objects",
        "More than one object type is visible — measure one part type at a time.",
      );
    }

    throw new MeasurementError(
      422,
      "no_object_detected",
      "No object detected on the calibration mat.",
    );
  }

  /*
   * Stage 4:
   * Convert Gemini's normalized image coordinates into real-world mm
   * using the deterministic calibration homography.
   */
  const measurement = measureFromMatHomography(
    outcome.measurement.corners,
    imageWidthPx,
    imageHeightPx,
    calibration.homography,
  );

  if (!measurement) {
    throw new MeasurementError(
      500,
      "internal_error",
      "Could not convert the object's corners to real-world millimetres.",
    );
  }

  /*
   * Measurement response consumed by the Raspberry Pi scan workflow.
   */
  const result: MeasurementResult = {
    name: outcome.measurement.name,
    description: outcome.measurement.description,

    lengthMM: measurement.lengthMM,
    widthMM: measurement.widthMM,

    heightMM: outcome.measurement.heightMM,

    angleDegrees: measurement.angleDegrees,

    dimensionConfidence: outcome.measurement.dimensionConfidence,

    calibrationRmsPixels: calibration.rmsReprojectionErrorPixels,

    observedQuantity: outcome.measurement.observedQuantity,

    quantityConfidence: outcome.measurement.quantityConfidence,
  };

  return result;
}
