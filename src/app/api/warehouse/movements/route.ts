import { NextResponse } from "next/server";
import { createMovement, listRecentMovements } from "@/lib/warehouse/repository";
import { intQueryParam, parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import type { CreateMovementInput } from "@/lib/warehouse/types";

/**
 * GET  /api/warehouse/movements        — most recent movements (?limit=)
 * POST /api/warehouse/movements        — record an intended movement
 *
 * Creating a movement records an intention only. It does not move stock and
 * it cannot be created in a terminal status — nothing here may imply that a
 * gantry actually did anything. That lifecycle is a later milestone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const movements = await listRecentMovements(intQueryParam(request, "limit"));
    return NextResponse.json({ movements });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const movement = await createMovement(body as unknown as CreateMovementInput);
    return NextResponse.json({ movement }, { status: 201 });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
