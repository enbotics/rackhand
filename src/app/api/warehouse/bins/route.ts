import { NextResponse } from "next/server";
import { findAvailableBin, getBinByCode, listBins } from "@/lib/warehouse/repository";
import { queryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * GET /api/warehouse/bins            — list every bin
 * GET /api/warehouse/bins?code=A01   — one bin
 * GET /api/warehouse/bins?available=1 — first AVAILABLE bin by code
 *
 * Bins carry no gantry coordinates — hardware addressing is a later milestone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const code = queryParam(request, "code");
    if (code) {
      const bin = await getBinByCode(code);
      if (!bin) throw new WarehouseError("bin_not_found", `No bin with code "${code}".`);
      return NextResponse.json({ bin });
    }

    if (queryParam(request, "available")) {
      const bin = await findAvailableBin();
      return NextResponse.json({ bin });
    }

    return NextResponse.json({ bins: await listBins() });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
