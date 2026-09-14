import { after, NextResponse } from "next/server";
import sharp from "sharp";

import { authenticateCameraDevice } from "@/lib/camera/device-auth";

import {
  CameraCaptureJobError,
  captureProcessingHeartbeatMilliseconds,
  claimCaptureForProcessing,
  completeCaptureJob,
  failCaptureJob,
  markCaptureUploaded,
  renewCaptureProcessingLease,
  requireDeviceCaptureJob,
} from "@/lib/camera/capture-job-service";

import { uploadCameraCapture } from "@/lib/camera/storage";

import {
  isMeasurementError,
  measureImageBuffer,
} from "@/lib/measurement/measure-image-buffer";
import { processPutawayCameraCapture } from "@/lib/warehouse/putaway-verification";
import { processAuditCameraCapture } from "@/lib/warehouse/audit-bin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Gives post-response measurement work enough time on platforms
 * that honor Next.js maxDuration.
 */
export const maxDuration = 300;

const MAX_UPLOAD_BYTES =
  Number(process.env.CAMERA_MAX_UPLOAD_MB ?? 12) * 1024 * 1024;

/**
 * Runs after the Pi has already received a successful upload response.
 *
 * Atomic claimCaptureForProcessing() prevents two upload retries from
 * processing the same capture simultaneously.
 */
async function processUploadedCapture(jobId: string, imageBuffer: Buffer) {
  const processingJob = await claimCaptureForProcessing(jobId);

  /*
   * null means another request/process already claimed it.
   *
   * This is expected with idempotent Pi upload retries.
   */
  if (!processingJob) {
    return;
  }

  console.info(`[camera] Processing capture ${jobId}`);

  const leaseHeartbeat = setInterval(() => {
    void renewCaptureProcessingLease(jobId).catch((error) => {
      console.warn(`[camera] Could not renew processing lease ${jobId}:`, error);
    });
  }, captureProcessingHeartbeatMilliseconds());

  try {
    let result: unknown;
    const captureInput = {
      imageBuffer,
      evidenceUrl: processingJob.evidenceUrl!,
      imageWidth: processingJob.imageWidth!,
      imageHeight: processingJob.imageHeight!,
      capturedAt: processingJob.capturedAt!,
      totalWeightGrams: processingJob.totalWeightGrams,
      weightSource: processingJob.weightSource,
    };

    switch (processingJob.purpose) {
      case "MANUAL_SCAN":
        result = await measureImageBuffer(imageBuffer);
        break;
      case "PUTAWAY_VERIFICATION":
        if (!processingJob.workflowCaptureId || processingJob.workflowAttempt === null) {
          throw new Error("Putaway camera job has no workflow capture attempt.");
        }
        result = await processPutawayCameraCapture(
          processingJob.workflowCaptureId,
          {
            ...captureInput,
            requestedAt: processingJob.requestedAt,
            workflowAttempt: processingJob.workflowAttempt,
          },
        );
        break;
      case "INVENTORY_AUDIT":
      case "RECOUNT":
        if (!processingJob.workflowCaptureId || processingJob.workflowAttempt === null) {
          throw new Error("Audit camera job has no workflow capture attempt.");
        }
        result = await processAuditCameraCapture(
          processingJob.workflowCaptureId,
          {
            ...captureInput,
            requestedAt: processingJob.requestedAt,
            workflowAttempt: processingJob.workflowAttempt,
          },
        );
        break;
      default:
        throw new Error(`Unsupported camera purpose: ${processingJob.purpose}`);
    }

    await completeCaptureJob(jobId, {
      result,
    });

    console.info(`[camera] Capture ${jobId} completed`);
  } catch (error) {
    console.error(`[camera] Measurement failed for ${jobId}:`, error);

    /*
     * Preserve useful domain error information in CameraCaptureJob.
     */
    const errorCode = isMeasurementError(error)
      ? `measurement_${error.code}`
      : "measurement_failed";

    const errorMessage =
      error instanceof Error ? error.message : "Measurement failed.";

    try {
      await failCaptureJob(jobId, {
        errorCode,
        errorMessage,
      });
    } catch (failError) {
      console.error(
        `[camera] Could not mark capture ${jobId} as FAILED:`,
        failError,
      );
    }
  } finally {
    clearInterval(leaseHeartbeat);
  }
}

function cameraJobErrorResponse(error: CameraCaptureJobError) {
  switch (error.code) {
    case "camera_job_expired":
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        {
          status: 410,
        },
      );

    case "camera_job_not_found":
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        {
          status: 404,
        },
      );

    default:
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        {
          status: 409,
        },
      );
  }
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  try {
    /*
     * 1. Authenticate Raspberry Pi.
     */
    const auth = authenticateCameraDevice(request);

    if (!auth.ok) {
      return NextResponse.json(
        {
          error: {
            code: "camera_unauthorized",
            message: "Invalid camera credentials.",
          },
        },
        {
          status: 401,
        },
      );
    }

    const { id } = await context.params;

    /*
     * 2. Verify that this job belongs to this device.
     */
    const existingJob = await requireDeviceCaptureJob(id, auth.deviceId);

    /*
     * Idempotent Pi retry.
     *
     * If upload succeeded previously but the Pi never received the HTTP
     * response, it may send the exact same JPEG again.
     *
     * PROCESSING / COMPLETED means there is nothing else for the Pi to do.
     */
    if (
      existingJob.status === "PROCESSING" ||
      existingJob.status === "COMPLETED"
    ) {
      return NextResponse.json({
        ok: true,
        jobId: existingJob.id,
        status: existingJob.status,
        alreadyUploaded: true,
      });
    }

    /*
     * UPLOADED is also safe to retry.
     *
     * We still accept the multipart body below so we have the image Buffer
     * available to schedule processing again if necessary.
     */
    const retryingUploadedJob = existingJob.status === "UPLOADED";

    if (existingJob.status !== "CLAIMED" && !retryingUploadedJob) {
      const status = existingJob.status === "EXPIRED" ? 410 : 409;

      return NextResponse.json(
        {
          error: {
            code:
              existingJob.status === "EXPIRED"
                ? "camera_job_expired"
                : "camera_invalid_job_state",

            message:
              existingJob.status === "EXPIRED"
                ? "The camera capture job has expired."
                : `Cannot upload while job is ${existingJob.status}.`,
          },
        },
        {
          status,
        },
      );
    }

    /*
     * 3. Parse multipart upload.
     */
    const formData = await request.formData();

    const image = formData.get("image");

    const capturedAtRaw = formData.get("capturedAt");

    const totalWeightGramsRaw = formData.get("totalWeightGrams");

    const weightSourceRaw = formData.get("weightSource");

    if (!(image instanceof File)) {
      return NextResponse.json(
        {
          error: {
            code: "image_required",
            message: "JPEG image is required.",
          },
        },
        {
          status: 422,
        },
      );
    }

    /*
     * Camera worker should always send JPEG.
     */
    if (image.type && image.type !== "image/jpeg") {
      return NextResponse.json(
        {
          error: {
            code: "invalid_image_type",
            message: "Only JPEG images are supported.",
          },
        },
        {
          status: 415,
        },
      );
    }

    if (image.size <= 0) {
      return NextResponse.json(
        {
          error: {
            code: "empty_image",
            message: "Uploaded image is empty.",
          },
        },
        {
          status: 422,
        },
      );
    }

    if (image.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: {
            code: "image_too_large",
            message: "Uploaded image exceeds the maximum allowed size.",
          },
        },
        {
          status: 413,
        },
      );
    }

    /*
     * 4. Convert multipart File -> Buffer.
     */
    const imageBuffer = Buffer.from(await image.arrayBuffer());

    /*
     * 5. Validate the actual image with Sharp.
     *
     * Do not trust dimensions supplied by the Pi.
     */
    let imageWidth: number;
    let imageHeight: number;

    try {
      const metadata = await sharp(imageBuffer).metadata();

      if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) {
        return NextResponse.json(
          {
            error: {
              code: "invalid_image",
              message: "Uploaded file is not a valid JPEG.",
            },
          },
          {
            status: 422,
          },
        );
      }

      imageWidth = metadata.width;

      imageHeight = metadata.height;
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "invalid_image",
            message: "Uploaded file could not be decoded.",
          },
        },
        {
          status: 422,
        },
      );
    }

    /*
     * 6. Parse capture timestamp.
     */
    let capturedAt = new Date();

    if (typeof capturedAtRaw === "string") {
      const parsed = new Date(capturedAtRaw);

      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          {
            error: {
              code: "invalid_captured_at",

              message: "capturedAt is invalid.",
            },
          },
          {
            status: 422,
          },
        );
      }

      capturedAt = parsed;
    }

    let totalWeightGrams: number | null = null;
    if (
      typeof totalWeightGramsRaw === "string" &&
      totalWeightGramsRaw.trim() !== ""
    ) {
      totalWeightGrams = Number(totalWeightGramsRaw);
      if (!Number.isFinite(totalWeightGrams) || totalWeightGrams <= 0) {
        return NextResponse.json(
          {
            error: {
              code: "invalid_total_weight",
              message: "totalWeightGrams must be a positive number.",
            },
          },
          { status: 422 },
        );
      }
    }
    let weightSource: "SCALE" | "FALLBACK" | null = null;
    if (typeof weightSourceRaw === "string" && weightSourceRaw.trim() !== "") {
      const normalized = weightSourceRaw.trim().toUpperCase();
      if (normalized !== "SCALE" && normalized !== "FALLBACK") {
        return NextResponse.json(
          {
            error: {
              code: "invalid_weight_source",
              message: "weightSource must be SCALE or FALLBACK.",
            },
          },
          { status: 422 },
        );
      }
      weightSource = normalized;
    }
    if (weightSource === null && totalWeightGrams !== null) {
      // Compatibility for a scale-aware worker deployed just before source
      // provenance was added: a supplied physical value was scale-derived.
      weightSource = "SCALE";
    }

    /*
     * 7. Store evidence.
     *
     * For UPLOADED retries we don't technically need to store again,
     * but overwriting the same job-id file is harmless with the current
     * local storage implementation and preserves simple idempotency.
     */
    const evidenceUrl = await uploadCameraCapture({
      jobId: id,
      imageBuffer,
      mimeType: "image/jpeg",
    });

    /*
     * 8. CLAIMED -> UPLOADED.
     *
     * markCaptureUploaded() is already idempotent according to the
     * capture-job service.
     */
    const uploadedJob = await markCaptureUploaded(id, auth.deviceId, {
      evidenceUrl,
      imageWidth,
      imageHeight,
      capturedAt,
      totalWeightGrams,
      weightSource,
    });

    /*
     * 9. Schedule the expensive measurement AFTER the Pi gets its response.
     *
     * This is important:
     *
     * Pi should not wait for:
     *   marker detection
     *   Gemini
     *   homography calculation
     *
     * The Pi's responsibility ends once the JPEG has safely reached
     * the server.
     */
    after(async () => {
      await processUploadedCapture(id, imageBuffer);
    });

    /*
     * 10. Immediately acknowledge the Pi.
     *
     * Database state at this exact instant is UPLOADED.
     * Shortly afterward it should become PROCESSING then COMPLETED.
     */
    return NextResponse.json(
      {
        ok: true,
        jobId: uploadedJob.id,
        status: uploadedJob.status,

        imageWidth: uploadedJob.imageWidth,

        imageHeight: uploadedJob.imageHeight,

        evidenceUrl: uploadedJob.evidenceUrl,

        processingScheduled: true,
      },
      {
        status: 200,
      },
    );
  } catch (error) {
    if (error instanceof CameraCaptureJobError) {
      console.warn("[camera] Capture job error:", error.code, error.message);

      return cameraJobErrorResponse(error);
    }

    console.error("[camera] Upload failed:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_upload_failed",

          message: "Could not upload camera image.",
        },
      },
      {
        status: 500,
      },
    );
  }
}
