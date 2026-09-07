import { NextResponse } from "next/server";
import { getGantryController } from "@/lib/gantry/factory";
import { assertGantryDevRoute, gantryErrorResponse, parseGantryBody } from "@/lib/gantry/http";
import type { PutawayRequest } from "@/lib/gantry/types";

/**
 * POST /api/gantry/putaway — { source: "INTAKE", destination: "B2-01" }
 *
 * Runs to completion and returns the GantryOperation. A rejected *request*
 * (bad location, gantry busy) is a 4xx; an operation that ran and failed is a
 * 200 whose body carries status "FAILED" and an `error` — the request
 * succeeded, the machine did not.
 *
 * This does NOT change inventory and does NOT create or complete a warehouse
 * Movement. Connecting the two is a later milestone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertGantryDevRoute();
    const body = await parseGantryBody(request);
    return NextResponse.json(await getGantryController().putaway(body as unknown as PutawayRequest));
  } catch (err) {
    return gantryErrorResponse(err);
  }
}
