import { NextResponse } from "next/server";
import { createPart, listParts } from "@/lib/warehouse/repository";
import { parseJsonBody, queryParam, intQueryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { CreatePartInput } from "@/lib/warehouse/types";
import { classifyReturnable } from "@/lib/agents/returnability-classifier";

/**
 * GET  /api/warehouse/parts  — list catalog parts (?category=, ?limit=)
 * POST /api/warehouse/parts  — create a catalog part
 *
 * A Part is authoritative catalog identity, deliberately unrelated to a
 * ScanResult's Gemini-derived detectedName. Nothing here accepts a scanId.
 *
 * `returnable` is never trusted from the request body — it's always the
 * LLM's own classification (returnability-classifier.ts), computed here
 * before createPart runs. A client-supplied value would be unenforceable
 * (nothing about "is this a shared tool" is the caller's call to make) and
 * silently overwritten either way.
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
    const input = body as unknown as CreatePartInput;
    const returnable = await classifyReturnable({
      canonicalName: typeof body.canonicalName === "string" ? body.canonicalName : "",
      category: typeof body.category === "string" ? body.category : null,
      description: typeof body.description === "string" ? body.description : null,
    });
    const part = await createPart({ ...input, returnable });
    return NextResponse.json({ part }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
