import { NextResponse } from "next/server";
import { requestPutawayCameraCapture } from "@/lib/warehouse/putaway-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const job = await requestPutawayCameraCapture(id);
    return NextResponse.json({
      captureJobId: job.id,
      status: job.status,
      requestedAt: job.requestedAt.toISOString(),
      expiresAt: job.expiresAt.toISOString(),
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
