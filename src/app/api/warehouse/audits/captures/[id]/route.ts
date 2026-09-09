import { NextResponse } from "next/server";
import { requestAuditCameraCapture } from "@/lib/warehouse/audit-bin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ask the Raspberry Pi for the fresh frame required by this audit. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const job = await requestAuditCameraCapture(id);
    return NextResponse.json({
      captureJobId: job.id,
      status: job.status,
      requestedAt: job.requestedAt.toISOString(),
      expiresAt: job.expiresAt?.toISOString() ?? null,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: {
        code: "camera_job_create_failed",
        message: error instanceof Error ? error.message : "The Raspberry Pi photo could not be requested.",
      },
    }, { status: 409 });
  }
}
