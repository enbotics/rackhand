import { NextResponse } from "next/server";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { returnGuidedPutawayBin } from "@/lib/warehouse/guided-putaway-service";
import { WarehouseError } from "@/lib/warehouse/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return the bin and freeze whether the operator placed the item. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseJsonBody(request);
    if (typeof body.placed !== "boolean") {
      throw new WarehouseError("validation_failed", "placed must be true or false.");
    }
    const { id } = await context.params;
    return NextResponse.json(await returnGuidedPutawayBin(id, body.placed));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}

