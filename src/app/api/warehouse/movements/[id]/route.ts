import { NextResponse } from "next/server";
import { getMovement, updateMovementStatus } from "@/lib/warehouse/repository";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { MovementStatus } from "@/lib/warehouse/types";

/**
 * GET   /api/warehouse/movements/[id] — fetch one movement
 * PATCH /api/warehouse/movements/[id] — { status } transition
 *
 * A transition to COMPLETED/FAILED/CANCELLED is always explicit and stamps
 * completedAt; terminal movements are frozen afterwards.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const movement = await getMovement(id);
    if (!movement) {
      throw new WarehouseError("movement_not_found", `No movement with id "${id}".`);
    }
    return NextResponse.json({ movement });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const movement = await updateMovementStatus(id, body.status as MovementStatus);
    return NextResponse.json({ movement });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
