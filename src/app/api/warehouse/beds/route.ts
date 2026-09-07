import { NextResponse } from "next/server";
import { createBed } from "@/lib/warehouse/repository";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { CreateBedInput } from "@/lib/warehouse/types";

/**
 * POST /api/warehouse/beds — create a brand-new bed: slots 01..slotCount, all
 * AVAILABLE. Fails with duplicate_bin_code if the bed already has any bins —
 * use POST /api/warehouse/beds/[bed] to add slots to an existing bed instead.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const bins = await createBed(body as unknown as CreateBedInput);
    return NextResponse.json({ bins }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
