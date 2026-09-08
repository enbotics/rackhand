import { NextResponse } from "next/server";
import sharp from "sharp";

import { authenticateCameraDevice } from "@/lib/camera/device-auth";
import {
  markCaptureUploaded,
  requireDeviceCaptureJob,
} from "@/lib/camera/capture-job-service";
import { uploadCameraCapture } from "@/lib/camera/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES =
  Number(process.env.CAMERA_MAX_UPLOAD_MB ?? 12) * 1024 * 1024;

export async function POST(
  request: Request,
  context: {
    params: Promise<{ id: string }>;
  },
) {
  try {
    const auth = authenticateCameraDevice(request);

    if (!auth.ok) {
      return NextResponse.json(
        {
          error: {
            code: "camera_unauthorized",
            message: "Invalid camera credentials.",
          },
        },
        { status: 401 },
      );
    }

    const { id } = await context.params;

    const job = await requireDeviceCaptureJob(id, auth.deviceId);

    // Idempotent retry.
    if (
      job.status === "UPLOADED" ||
      job.status === "PROCESSING" ||
      job.status === "COMPLETED"
    ) {
      return NextResponse.json({
        ok: true,
        jobId: job.id,
        status: job.status,
        alreadyUploaded: true,
      });
    }

    if (job.status !== "CLAIMED") {
      return NextResponse.json(
        {
          error: {
            code: "camera_invalid_job_state",
            message: `Cannot upload while job is ${job.status}.`,
          },
        },
        { status: 409 },
      );
    }

    const formData = await request.formData();

    const image = formData.get("image");
    const capturedAtRaw = formData.get("capturedAt");

    if (!(image instanceof File)) {
      return NextResponse.json(
        {
          error: {
            code: "image_required",
            message: "JPEG image is required.",
          },
        },
        { status: 422 },
      );
    }

    if (image.type !== "image/jpeg") {
      return NextResponse.json(
        {
          error: {
            code: "invalid_image_type",
            message: "Only JPEG images are supported.",
          },
        },
        { status: 415 },
      );
    }

    if (image.size <= 0 || image.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_image_size",
            message: "Image size is invalid.",
          },
        },
        { status: 413 },
      );
    }

    const imageBuffer = Buffer.from(await image.arrayBuffer());

    const metadata = await sharp(imageBuffer).metadata();

    if (!metadata.width || !metadata.height || metadata.format !== "jpeg") {
      return NextResponse.json(
        {
          error: {
            code: "invalid_image",
            message: "Uploaded file is not a valid JPEG.",
          },
        },
        { status: 422 },
      );
    }

    const capturedAt =
      typeof capturedAtRaw === "string" ? new Date(capturedAtRaw) : new Date();

    if (Number.isNaN(capturedAt.getTime())) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_captured_at",
            message: "capturedAt is invalid.",
          },
        },
        { status: 422 },
      );
    }

    const evidenceUrl = await uploadCameraCapture({
      jobId: id,
      imageBuffer,
      mimeType: "image/jpeg",
    });

    const updated = await markCaptureUploaded(id, auth.deviceId, {
      evidenceUrl,
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      capturedAt,
    });

    return NextResponse.json({
      ok: true,
      jobId: updated.id,
      status: updated.status,
      imageWidth: updated.imageWidth,
      imageHeight: updated.imageHeight,
      evidenceUrl: updated.evidenceUrl,
    });
  } catch (error) {
    console.error("[camera] Upload failed:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_upload_failed",
          message: "Could not upload camera image.",
        },
      },
      { status: 500 },
    );
  }
}
