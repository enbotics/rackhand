import { NextResponse } from "next/server";
import { registerScanAsPart } from "@/lib/warehouse/catalog-registration-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { ScanResult } from "@/lib/warehouse/scan-types";

/**
 * POST /api/warehouse/catalog/register — { scanResult, imageDataUrl? } -> { outcome, part }
 *
 * The one place a scan without a settled identity may become a new catalog
 * Part — a deliberate operator action, distinct from /catalog/match (which
 * stays read-only regardless of the verdict, unchanged). Re-verifies
 * server-side that this is actually allowed before creating anything; see
 * catalog-registration-service.ts. `imageDataUrl` becomes the new part's
 * representative photo — optional, and never blocks registration if omitted
 * or if the upload itself fails.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    if (body.imageDataUrl !== undefined && typeof body.imageDataUrl !== "string") {
      throw new WarehouseError("validation_failed", "Invalid imageDataUrl.");
    }
    const result = await registerScanAsPart(
      body.scanResult as ScanResult,
      typeof body.imageDataUrl === "string" ? body.imageDataUrl : undefined,
    );
    return NextResponse.json(result, { status: result.outcome === "created" ? 201 : 200 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
