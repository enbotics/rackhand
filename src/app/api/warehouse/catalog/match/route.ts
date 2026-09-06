import { NextResponse } from "next/server";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { ScanResult } from "@/lib/warehouse/scan-types";

/**
 * POST /api/warehouse/catalog/match — { scanResult } -> CatalogMatchResult
 *
 * Thin by design: the route parses the body and delegates. All matching logic
 * lives in lib/warehouse/catalog-matcher.ts, which also re-validates the
 * scanResult (a browser-posted scan is untrusted) using the Milestone 1
 * contract rules rather than a second, competing definition.
 *
 * Read-only. This endpoint never creates a Part, assigns a SKU, changes
 * inventory, or records a movement — even when the answer is NO_MATCH.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const result = await matchScanToCatalog(body.scanResult as ScanResult);
    return NextResponse.json(result);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
