import { NextResponse } from "next/server";
import { pendingAuditCapture } from "@/lib/warehouse/audit-bin-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only poll used by the already-open Warehouse Command Center camera. */
export async function GET(request: Request) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return NextResponse.json({ error: { code: "warehouse_session_required" } }, { status: 400 });
  return NextResponse.json(await pendingAuditCapture(sessionId));
}
