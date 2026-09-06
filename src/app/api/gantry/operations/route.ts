import { NextResponse } from "next/server";
import { getGantryController } from "@/lib/gantry/factory";
import { gantryErrorResponse } from "@/lib/gantry/http";

/**
 * GET /api/gantry/operations?limit=20 — recent machine operations, newest
 * first. In-memory and process-local; the authoritative warehouse history
 * lives in the Movement table, which this does not touch.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("limit");
    const parsed = raw === null ? undefined : Number(raw);
    const limit = parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;

    return NextResponse.json({ operations: await getGantryController().getRecentOperations(limit) });
  } catch (err) {
    return gantryErrorResponse(err);
  }
}
