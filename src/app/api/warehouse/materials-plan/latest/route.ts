import { NextResponse } from "next/server";
import { getLatestMaterialsPlanCheck } from "@/lib/warehouse/materials-plan-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

/**
 * GET /api/warehouse/materials-plan/latest
 *
 * This session's latest legacy build-plan stock check. New plans use
 * approval-gated fulfillment and create no check rows; this read-only route is
 * retained so historical reports remain renderable and session-isolated.
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
