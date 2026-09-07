import { NextResponse } from "next/server";
import { warehouseErrorResponse } from "@/lib/warehouse/http";
import { presentGuidedPutawayBin } from "@/lib/warehouse/guided-putaway-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Run the five-second simulated transfer that presents the selected bin. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await presentGuidedPutawayBin(id));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}

