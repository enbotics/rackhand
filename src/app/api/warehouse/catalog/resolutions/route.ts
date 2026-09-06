import { NextResponse } from "next/server";
import { requestCatalogResolution } from "@/lib/warehouse/catalog-resolution-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";

/**
 * POST /api/warehouse/catalog/resolutions — { scanResult }
 *
 * Re-runs the deterministic matcher and, only when it returns AMBIGUOUS, opens
 * a pending human identity decision listing exactly which parts may be chosen.
 *
 * MATCHED needs no decision. NO_MATCH is deliberately not resolvable: offering
 * a list to pick from when the matcher found no plausible candidate would be
 * inviting a guess, and registering a new part is a separate workflow.
 * A structurally invalid scan asks for a rescan — a person must not override
 * broken measurement evidence.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const result = await requestCatalogResolution(body.scanResult);
    return NextResponse.json(result);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
