import { NextResponse } from "next/server";

import {
  CameraCaptureJobError,
  failDeviceCaptureJob,
} from "@/lib/camera/capture-job-service";
import { authenticateCameraDevice } from "@/lib/camera/device-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobErrorResponse(error: CameraCaptureJobError) {
  const status = error.code === "camera_job_not_found" ? 404 : 409;
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status },
  );
}

/** Records a physical capture failure reported by the authenticated Pi. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "invalid_json",
            message: "Camera failure body must be valid JSON.",
          },
        },
        { status: 400 },
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_camera_failure",
            message: "Camera failure body must be an object.",
          },
        },
        { status: 422 },
      );
    }

    const payload = body as Record<string, unknown>;
    const errorCode =
      typeof payload.errorCode === "string" ? payload.errorCode.trim() : "";
    const errorMessage =
      typeof payload.errorMessage === "string"
        ? payload.errorMessage.trim()
        : null;
    if (!errorCode || errorCode.length > 100) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_camera_failure",
            message: "errorCode must contain between 1 and 100 characters.",
          },
        },
        { status: 422 },
      );
    }

    const { id } = await context.params;
    const job = await failDeviceCaptureJob(id, auth.deviceId, {
      errorCode,
      errorMessage,
    });
    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: job.status,
    });
  } catch (error) {
    if (error instanceof CameraCaptureJobError) return jobErrorResponse(error);
    console.error("[camera] Failed to record device capture failure:", error);
    return NextResponse.json(
      {
        error: {
          code: "camera_failure_report_failed",
          message: "Could not record the camera failure.",
        },
      },
      { status: 500 },
    );
  }
}
