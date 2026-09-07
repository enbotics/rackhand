import { NextResponse } from "next/server";
import { addBinsToBed, deleteBed } from "@/lib/warehouse/repository";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * POST   /api/warehouse/beds/[bed] — add more bins to an existing bed
 * DELETE /api/warehouse/beds/[bed] — delete every bin in a bed (blocked if any hold inventory)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `[bed]` arrives as a route-param string — reject anything non-numeric before it reaches a query. */
function parseBedParam(raw: string): number {
  const bed = Number(raw);
  if (!Number.isInteger(bed) || bed <= 0) {
    throw new WarehouseError("validation_failed", `"${raw}" is not a valid bed number.`);
  }
  return bed;
}

export async function POST(request: Request, context: { params: Promise<{ bed: string }> }) {
  try {
    const { bed: bedParam } = await context.params;
    const bed = parseBedParam(bedParam);
    const body = await parseJsonBody(request);
    const bins = await addBinsToBed({ bed, slotCount: body.slotCount as number });
    return NextResponse.json({ bins }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ bed: string }> }) {
  try {
    const { bed: bedParam } = await context.params;
    const bed = parseBedParam(bedParam);
    const result = await deleteBed(bed);
    return NextResponse.json(result);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
