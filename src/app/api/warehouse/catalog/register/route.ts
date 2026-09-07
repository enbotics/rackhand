import { NextResponse } from "next/server";
import { registerScanAsPart } from "@/lib/warehouse/catalog-registration-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { ScanResult } from "@/lib/warehouse/scan-types";

/**
 * POST /api/warehouse/catalog/register — { scanResult } -> { outcome, part }
 *
 * The one place a NO_MATCH scan may become a new catalog Part — a deliberate
 * operator action, distinct from /catalog/match (which stays read-only even
 * on NO_MATCH, unchanged). Re-verifies the scan is still NO_MATCH server-side
 * before creating anything; see catalog-registration-service.ts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const result = await registerScanAsPart(body.scanResult as ScanResult);
    return NextResponse.json(result, { status: result.outcome === "created" ? 201 : 200 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
