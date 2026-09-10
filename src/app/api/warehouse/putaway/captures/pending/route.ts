import { pendingPutawayCapture } from "@/lib/warehouse/putaway-verification";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return Response.json({ error: { code: "warehouse_session_required" } }, { status: 400 });
  return Response.json(await pendingPutawayCapture(sessionId));
}
