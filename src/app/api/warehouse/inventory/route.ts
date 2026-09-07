import { NextResponse } from "next/server";
import {
  addInventory,
  getInventoryByBin,
  getInventoryForPart,
  listInventory,
  removeInventory,
  setInventoryQuantity,
} from "@/lib/warehouse/inventory-service";
import { parseJsonBody, queryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { InventoryMutationInput } from "@/lib/warehouse/types";

/**
 * GET  /api/warehouse/inventory?sku=BRG-6204 — stock for one part
 * GET  /api/warehouse/inventory?bin=B2-01      — stock in one bin
 * GET  /api/warehouse/inventory              — every inventory row
 * POST /api/warehouse/inventory              — { action: "add" | "remove" | "set", sku, binCode, quantity }
 *
 * The service layer runs every mutation in a transaction with the quantity
 * guard in the UPDATE itself, so a request can never drive stock negative.
 * "set" is a direct override (the bin-detail modal's quantity edit) — it
 * records an ADJUSTMENT movement with the before/after, unlike add/remove.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sku = queryParam(request, "sku");
    if (sku) return NextResponse.json(await getInventoryForPart(sku));

    const bin = queryParam(request, "bin");
    if (bin) return NextResponse.json({ binCode: bin.toUpperCase(), inventory: await getInventoryByBin(bin) });

    return NextResponse.json({ inventory: await listInventory() });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const action = body.action === undefined ? "add" : body.action;
    if (action !== "add" && action !== "remove" && action !== "set") {
      throw new WarehouseError("validation_failed", 'action must be "add", "remove" or "set".', [
        "action must be one of: add, remove, set",
      ]);
    }

    const input = body as unknown as InventoryMutationInput;
    const inventory =
      action === "add"
        ? await addInventory(input)
        : action === "remove"
          ? await removeInventory(input)
          : await setInventoryQuantity(input);
    return NextResponse.json({ action, inventory });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
