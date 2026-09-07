import { NextResponse } from "next/server";
import { createBin, findAvailableBin, getBinByCode, listBins } from "@/lib/warehouse/repository";
import { parseJsonBody, queryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { CreateBinInput } from "@/lib/warehouse/types";

/**
 * GET  /api/warehouse/bins            — list every bin
 * GET  /api/warehouse/bins?code=B1-01   — one bin
 * GET  /api/warehouse/bins?available=1 — first AVAILABLE bin by code
 * POST /api/warehouse/bins            — create a single bin
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

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const bin = await createBin(body as unknown as CreateBinInput);
    return NextResponse.json({ bin }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
