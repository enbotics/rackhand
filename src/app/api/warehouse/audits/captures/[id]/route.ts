import { NextResponse } from "next/server";
import { requestAuditCameraCapture } from "@/lib/warehouse/audit-bin-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";
import { getCaptureJobStatus } from "@/lib/camera/capture-job-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start the next capture using the workflow's fixed production/simulation source. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return NextResponse.json({ error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } }, { status: 400 });
  const { id } = await context.params;
  try {
    const capture = await requestAuditCameraCapture(id, sessionId);
    if (capture.captureMode === "SIMULATION") {
      return NextResponse.json({
        captureMode: capture.captureMode,
        result: capture.result,
      }, { status: 200 });
    }
    const { job } = capture;
    const queued = await getCaptureJobStatus(job.id, sessionId);
    return NextResponse.json({
      captureMode: capture.captureMode,
      captureJobId: job.id,
      status: job.status,
      requestedAt: job.requestedAt.toISOString(),
      expiresAt: job.expiresAt?.toISOString() ?? null,
      queuePosition: queued.queuePosition,
    }, { status: 201 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return NextResponse.json({
      error: {
        code: "camera_job_create_failed",
        message: reason || "The Raspberry Pi photo could not be requested.",
      },
    }, { status: reason.includes("another operator session") ? 403 : 409 });
  }
}
