import { NextResponse } from "next/server";
import { forceResetStaleBins } from "@/lib/warehouse/admin-reset-service";
import { warehouseErrorResponse } from "@/lib/warehouse/http";

/**
 * POST /api/warehouse/admin/force-reset
 *
 * Operator-only admin action, deliberately unreachable from the agent: reverts
 * every bin stuck in RESERVED / CHECKED_OUT / AUDITING back to its prior
 * status and fails any dangling Movement/capture/audit row still pointing at
 * it. See admin-reset-service.ts for why this never touches Inventory.quantity.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const summary = await forceResetStaleBins();
    return NextResponse.json(summary);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
