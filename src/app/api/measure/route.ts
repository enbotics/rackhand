import { NextResponse } from "next/server";

import {
  isMeasurementError,
  measureImageBuffer,
} from "@/lib/measurement/measure-image-buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MeasureRequestBody {
  imageDataUrl?: string;

  /**
   * Kept only for backwards compatibility with the existing browser client.
   *
   * They are intentionally NOT used for measurement.
   * The server reads the authoritative dimensions from the decoded image.
   */
  imageWidthPx?: number;
  imageHeightPx?: number;
}

const MAX_IMAGE_BYTES =
  Number(process.env.MEASURE_MAX_IMAGE_MB ?? 15) * 1024 * 1024;

function fail(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
    },
  );
}

export async function POST(request: Request) {
  let body: MeasureRequestBody;

  try {
    body = await request.json();
  } catch {
    return fail(400, "malformed_request", "Body is not parseable JSON.");
  }

  const { imageDataUrl } = body;

  /*
   * Keep accepting stored-shot data URLs for history remeasurement.
   *
   * Examples:
   * data:image/jpeg;base64,...
   * data:image/png;base64,...
   * data:image/webp;base64,...
   */
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    return fail(
      422,
      "validation_failed",
      "imageDataUrl must be a valid image data URL.",
    );
  }

  const commaIndex = imageDataUrl.indexOf(",");

  if (commaIndex < 0) {
    return fail(422, "validation_failed", "imageDataUrl is malformed.");
  }

  const metadata = imageDataUrl.slice(0, commaIndex);

  if (!metadata.includes(";base64")) {
    return fail(
      422,
      "validation_failed",
      "imageDataUrl must contain base64 image data.",
    );
  }

  const base64 = imageDataUrl.slice(commaIndex + 1);

  if (!base64) {
    return fail(422, "validation_failed", "Image data is empty.");
  }

  let imageBuffer: Buffer;

  try {
    imageBuffer = Buffer.from(base64, "base64");
  } catch {
    return fail(422, "validation_failed", "Image data is not valid base64.");
  }

  if (imageBuffer.length === 0) {
    return fail(422, "validation_failed", "Image data is empty.");
  }

  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    return fail(
      413,
      "image_too_large",
      "Image exceeds the maximum allowed size.",
    );
  }

  try {
    const result = await measureImageBuffer(imageBuffer);

    return NextResponse.json(result, {
      status: 200,
    });
  } catch (error) {
    if (isMeasurementError(error)) {
      return fail(error.status, error.code, error.message);
    }

    console.error("[measure] Unexpected measurement error:", error);

    return fail(500, "internal_error", "Unexpected measurement failure.");
  }
}
