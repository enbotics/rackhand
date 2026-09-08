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
 * `placed: true` must carry a fresh verification photo — the service itself
 * enforces that (placement_photo_required/placement_photo_upload_failed);
 * this route only checks the shape of what was sent.
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
    if (
      body.placed &&
      (typeof body.verificationImageDataUrl !== "string" ||
        typeof body.verificationCapturedAt !== "number")
    ) {
      throw new WarehouseError(
        "validation_failed",
        "A verification photo and its capture time are required when placed is true.",
      );
    }

    const decision = (
      body.placed
        ? {
            placed: true,
            verificationImageDataUrl: body.verificationImageDataUrl,
            verificationCapturedAt: body.verificationCapturedAt,
          }
        : { placed: false }
    ) as GuidedPlacementDecision;

    const { id } = await context.params;
    return NextResponse.json(await returnGuidedPutawayBin(id, decision));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}
