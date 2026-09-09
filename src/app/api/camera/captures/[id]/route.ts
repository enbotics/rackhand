import { NextResponse } from "next/server";

import {
  CameraCaptureJobError,
  expireStaleCaptureJobs,
  requireCaptureJob,
} from "@/lib/camera/capture-job-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseResult(value: string | null): unknown {
  if (!value) return null;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  try {
    const { id } = await context.params;

    // Status reads also perform timeout recovery, so a stopped Pi worker is
    // not required to poll again before the browser can observe a terminal job.
    await expireStaleCaptureJobs();
    const job = await requireCaptureJob(id);

    return NextResponse.json({
      captureJobId: job.id,
      purpose: job.purpose,
      status: job.status,

      evidenceUrl: job.evidenceUrl,

      imageWidth: job.imageWidth,

      imageHeight: job.imageHeight,

      requestedAt: job.requestedAt.toISOString(),

      claimedAt: job.claimedAt?.toISOString() ?? null,

      capturedAt: job.capturedAt?.toISOString() ?? null,

      uploadedAt: job.uploadedAt?.toISOString() ?? null,

      completedAt: job.completedAt?.toISOString() ?? null,

      expiresAt: job.expiresAt?.toISOString() ?? null,

      result: parseResult(job.resultJson),

      error: job.errorCode
        ? {
            code: job.errorCode,
            message: job.errorMessage ?? "Camera capture failed.",
          }
        : null,
    });
  } catch (error) {
    if (error instanceof CameraCaptureJobError) {
      const status = error.code === "camera_job_not_found" ? 404 : 409;

      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        {
          status,
        },
      );
    }

    console.error("[camera] Could not read capture job:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_job_status_failed",
          message: "Could not read camera capture status.",
        },
      },
      {
        status: 500,
      },
    );
  }
}
