import { NextResponse } from "next/server";
import { getPartById, getPartBySku } from "@/lib/warehouse/repository";
import { warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * GET /api/warehouse/parts/[id] — fetch one catalog part.
 *
 * Accepts either the internal database id or a SKU, so callers holding
 * either identifier can resolve a part without a second endpoint.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const part = (await getPartById(id)) ?? (await getPartBySku(id));
    if (!part) {
      throw new WarehouseError("part_not_found", `No catalog part matching "${id}".`);
    }
    return NextResponse.json({ part });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
