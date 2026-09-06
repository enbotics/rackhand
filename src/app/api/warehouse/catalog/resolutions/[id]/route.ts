import { NextResponse } from "next/server";
import {
  confirmCatalogResolution,
  getCatalogResolution,
  rejectCatalogResolution,
  toResolutionView,
} from "@/lib/warehouse/catalog-resolution-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * GET  /api/warehouse/catalog/resolutions/[id] — current state
 * POST /api/warehouse/catalog/resolutions/[id] — { decision: "CONFIRM" | "REJECT", partId? }
 *
 * The operator may confirm ONLY a part that was offered as a candidate for
 * this resolution, whatever the request body claims. Confirmation is
 * server-validated and, once CONFIRMED, immutable — switching the selected
 * part afterwards would rewrite history that stock may already depend on.
 *
 * Nothing here touches inventory, bins or the gantry. Deciding what a part IS
 * does not authorise moving it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const row = await getCatalogResolution(id);
    if (!row) {
      throw new WarehouseError("validation_failed", `No resolution "${id}".`);
    }
    return NextResponse.json(toResolutionView(row));
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const decision = body.decision;

    if (decision !== "CONFIRM" && decision !== "REJECT") {
      throw new WarehouseError("validation_failed", "Invalid decision.", [
        'decision must be "CONFIRM" or "REJECT"',
      ]);
    }

    if (decision === "REJECT") {
      const rejected = await rejectCatalogResolution(id);
      return NextResponse.json(rejected, { status: rejected.ok ? 200 : 409 });
    }

    if (typeof body.partId !== "string" || body.partId.trim() === "") {
      throw new WarehouseError("validation_failed", "Invalid partId.", [
        "partId must be a non-empty string when confirming",
      ]);
    }

    const confirmed = await confirmCatalogResolution(id, body.partId.trim());
    return NextResponse.json(confirmed, { status: confirmed.ok ? 200 : 409 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
