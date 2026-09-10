import { NextResponse } from "next/server";
import { reanalyzePutawayCapture } from "@/lib/warehouse/putaway-verification";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Reuse the durable JPEG after an infrastructure/model analysis failure. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) {
    return NextResponse.json(
      {
        error: {
          code: "warehouse_session_required",
          message: "A valid warehouse session is required.",
        },
      },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  try {
    return NextResponse.json({
      result: await reanalyzePutawayCapture(id, sessionId),
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "The saved photo could not be analyzed again.";
    return NextResponse.json(
      { error: { code: "putaway_reanalysis_failed", message } },
      { status: message.includes("another operator session") ? 403 : 409 },
    );
  }
}
