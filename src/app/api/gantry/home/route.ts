import { NextResponse } from "next/server";
import { getGantryController } from "@/lib/gantry/factory";
import { assertGantryDevRoute, gantryErrorResponse } from "@/lib/gantry/http";

/**
 * POST /api/gantry/home — establish the reference position.
 *
 * Waits for the operation to finish and returns the completed record; the
 * simulator's delays are short enough that a synchronous response is fine for
 * this MVP, so there is no queue.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    assertGantryDevRoute();
    return NextResponse.json(await getGantryController().home());
  } catch (err) {
    return gantryErrorResponse(err);
  }
}
