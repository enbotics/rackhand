import { NextResponse } from "next/server";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { returnGuidedPutawayBin } from "@/lib/warehouse/guided-putaway-service";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { GuidedPlacementDecision } from "@/lib/warehouse/guided-putaway-types";

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
    let decision: GuidedPlacementDecision;
    if (body.placed) {
      if (
        typeof body.verificationImageDataUrl !== "string" ||
        typeof body.verificationCapturedAt !== "number"
      ) {
        throw new WarehouseError(
          "validation_failed",
          "A verification photo and capture time are required before returning a filled bin.",
        );
      }
      decision = {
        placed: true,
        verificationImageDataUrl: body.verificationImageDataUrl,
        verificationCapturedAt: body.verificationCapturedAt,
      };
    } else {
      decision = { placed: false };
    }
    const { id } = await context.params;
    return NextResponse.json(await returnGuidedPutawayBin(id, decision));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}
