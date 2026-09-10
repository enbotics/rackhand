import { NextResponse } from "next/server";
import { requestRetrievalCameraCapture } from "@/lib/warehouse/retrieval-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const capture = await requestRetrievalCameraCapture(id);
    if (capture.captureMode === "SIMULATION") {
      return NextResponse.json({
        captureMode: capture.captureMode,
        result: capture.result,
      }, { status: 200 });
    }
    const { job } = capture;
    return NextResponse.json({
      captureMode: capture.captureMode,
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
