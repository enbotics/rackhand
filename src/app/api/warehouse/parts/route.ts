import { NextResponse } from "next/server";
import { createPart, listParts } from "@/lib/warehouse/repository";
import { parseJsonBody, queryParam, intQueryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { CreatePartInput } from "@/lib/warehouse/types";

/**
 * GET  /api/warehouse/parts  — list catalog parts (?category=, ?limit=)
 * POST /api/warehouse/parts  — create a catalog part
 *
 * A Part is authoritative catalog identity, deliberately unrelated to a
 * ScanResult's Gemini-derived detectedName. Nothing here accepts a scanId.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const parts = await listParts({
      category: queryParam(request, "category") ?? undefined,
      limit: intQueryParam(request, "limit"),
    });
    return NextResponse.json({ parts });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const part = await createPart(body as unknown as CreatePartInput);
    return NextResponse.json({ part }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
