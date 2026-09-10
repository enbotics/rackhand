import { NextResponse } from "next/server";

import {
  CameraCaptureJobError,
  expireStaleCaptureJobs,
  getCaptureJobStatus,
} from "@/lib/camera/capture-job-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  try {
    const ownerSessionId = warehouseSessionIdFromRequest(request);
    if (!ownerSessionId) {
      return NextResponse.json(
        { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
        { status: 400 },
      );
    }
    const { id } = await context.params;

    // Status reads also perform timeout recovery, so a stopped Pi worker is
    // not required to poll again before the browser can observe a terminal job.
    await expireStaleCaptureJobs();
    const job = await getCaptureJobStatus(id, ownerSessionId);

    return NextResponse.json({
      ...job,
      id: undefined,
      captureJobId: job.id,
    });
  } catch (error) {
    if (error instanceof CameraCaptureJobError) {
      const status = error.code === "camera_job_not_found"
        ? 404
        : error.code === "camera_job_not_owned"
          ? 403
          : 409;

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
