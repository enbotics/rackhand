import { NextResponse } from "next/server";
import { getLatestMaterialsPlanCheck } from "@/lib/warehouse/materials-plan-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

/**
 * GET /api/warehouse/materials-plan/latest
 *
 * This session's own latest build-plan stock check, polled by the client the
 * same way audit progress already is — see use-materials-plan.ts. Session-
 * scoped (mirrors pendingAuditCapture's ownerSessionId pattern) rather than
 * folded into the shared, unscoped /api/warehouse/overview: two operators
 * running their own build-plan checks must never see each other's.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ownerSessionId = warehouseSessionIdFromRequest(request);
  if (!ownerSessionId) {
    return NextResponse.json({ materialsPlanCheck: null });
  }
  const materialsPlanCheck = await getLatestMaterialsPlanCheck(ownerSessionId);
  return NextResponse.json({ materialsPlanCheck });
}
