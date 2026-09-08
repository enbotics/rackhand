import { NextResponse } from "next/server";
import { warehouseErrorResponse } from "@/lib/warehouse/http";
import { commitGuidedPutaway } from "@/lib/warehouse/guided-putaway-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Persist inventory after—and only after—the bin return completed. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await commitGuidedPutaway(id));
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}
