import { NextResponse } from "next/server";
import { decideAuditCapture } from "@/lib/warehouse/audit-bin-service";
import type { AuditCaptureDecision } from "@/lib/warehouse/audit-capture-types";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return NextResponse.json({ error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } }, { status: 400 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Body is not valid JSON." } }, { status: 400 });
  }
  const decision = (body as { decision?: unknown } | null)?.decision;
  if (decision !== "ACCEPT" && decision !== "RETRY") {
    return NextResponse.json({ error: { message: "Decision must be ACCEPT or RETRY." } }, { status: 422 });
  }
  try {
    await decideAuditCapture(id, decision as AuditCaptureDecision, sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "audit_capture_failed";
    const wrongOwner = reason.includes("another operator session");
    const message = wrongOwner
      ? reason
      : reason === "audit_inventory_stale"
        ? "Inventory changed after this photo was analyzed. Take a fresh photo before confirming."
        : reason === "audit_lock_lost"
          ? "This bin is no longer locked for the current audit."
          : "This audit verification is no longer awaiting that decision.";
    return NextResponse.json({ error: { message } }, { status: wrongOwner ? 403 : 409 });
  }
}
