import { NextResponse } from "next/server";

import {
  createCaptureJob,
  getCaptureJobStatus,
} from "@/lib/camera/capture-job-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ownerSessionId = warehouseSessionIdFromRequest(request);
  if (!ownerSessionId) {
    return NextResponse.json(
      { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
      { status: 400 },
    );
  }
  try {
    const job = await createCaptureJob({
      purpose: "MANUAL_SCAN",
      ownerSessionId,
    });
    const queued = await getCaptureJobStatus(job.id, ownerSessionId);

    return NextResponse.json(
      {
        captureJobId: job.id,
        status: job.status,
        requestedAt: job.requestedAt.toISOString(),
        expiresAt: job.expiresAt?.toISOString() ?? null,
        queuePosition: queued.queuePosition,
      },
      {
        status: 201,
      },
    );
  } catch (error) {
    console.error("[camera] Failed to create capture job:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_job_create_failed",
          message: "Could not create a camera capture request.",
        },
      },
      {
        status: 500,
      },
    );
  }
}
