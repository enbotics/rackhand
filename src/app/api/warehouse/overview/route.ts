import { NextResponse } from "next/server";
import { getWarehouseOverview } from "@/lib/warehouse/dashboard-service";
import { intQueryParam, warehouseErrorResponse } from "@/lib/warehouse/http";

/**
 * GET /api/warehouse/overview?movements=8 — one authoritative snapshot of
 * warehouse state for the command centre: bins with their contents, inventory
 * grouped by part, and the most recent movements.
 *
 * The only endpoint added in Milestone 10. It exists because the dashboard
 * needs bins, stock and history to be CONSISTENT with each other — three
 * separate polls can interleave with a putaway and paint a bin as occupied
 * while inventory still shows it empty. One request, one snapshot.
 *
 * Strictly read-only, and deliberately separate from /api/gantry/status: the
 * machine is polled at a different cadence, and a gantry fault must never take
 * the inventory panel down with it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await getWarehouseOverview(intQueryParam(request, "movements")));
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
