import { NextResponse } from "next/server";
import { getGantryController } from "@/lib/gantry/factory";
import { assertGantryDevRoute, gantryErrorResponse, parseGantryBody } from "@/lib/gantry/http";
import type { RetrievalRequest } from "@/lib/gantry/types";

/**
 * POST /api/gantry/retrieve — { source: "B2-01", destination: "OUTPUT" }
 *
 * Same contract as putaway: synchronous completion, 4xx for a rejected
 * request, 200 with status "FAILED" for an operation that ran and failed.
 *
 * This does NOT decrement inventory and does NOT complete a warehouse
 * Movement.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertGantryDevRoute();
    const body = await parseGantryBody(request);
    return NextResponse.json(
      await getGantryController().retrieve(body as unknown as RetrievalRequest),
    );
  } catch (err) {
    return gantryErrorResponse(err);
  }
}
