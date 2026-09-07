import { NextResponse } from "next/server";
import { deleteBin, updateBin } from "@/lib/warehouse/repository";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { UpdateBinInput } from "@/lib/warehouse/types";

/**
 * PATCH  /api/warehouse/bins/[code] — update a bin's status/capacity
 * DELETE /api/warehouse/bins/[code] — delete a bin (blocked if it holds inventory)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const body = await parseJsonBody(request);
    const bin = await updateBin(code, body as unknown as UpdateBinInput);
    return NextResponse.json({ bin });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    await deleteBin(code);
    return NextResponse.json({ deleted: code });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
