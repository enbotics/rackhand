import { NextResponse } from "next/server";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { returnGuidedPutawayBin } from "@/lib/warehouse/guided-putaway-service";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { GuidedPlacementDecision } from "@/lib/warehouse/guided-putaway-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the bin and freeze the placement decision.
 *
 * `placed: true` starts the server-owned Raspberry Pi verification handshake.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseJsonBody(request);
    if (typeof body.placed !== "boolean") {
      throw new WarehouseError("validation_failed", "placed must be true or false.");
    }
    const decision = { placed: body.placed } as GuidedPlacementDecision;

    const { id } = await context.params;
    return NextResponse.json(await returnGuidedPutawayBin(id, decision));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}
