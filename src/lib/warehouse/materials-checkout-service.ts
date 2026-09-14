import { prisma } from "./db";
import { getAuditCaptureMode, isOutOfSimulationScope, SimulationScopeError } from "./audit-capture-mode";
import type { MaterialsFulfillmentBin } from "./materials-fulfillment-service";
import { RETRIEVAL_DESTINATION, type RetrievalResult } from "./retrieval-types";
import { TERMINAL_MOVEMENT_STATUSES } from "./types";

/** Read-only reuse of a completed, verified simulation checkout; never moves a bin. */
export async function resumeMaterialsCheckout(
  selection: MaterialsFulfillmentBin,
  requestId: string,
): Promise<RetrievalResult> {
  const failure = (message: string): RetrievalResult => ({
    ok: false,
    requestId,
    reason: "inventory_conflict",
    sourceBinCode: selection.binCode,
    message,
  });
  if (getAuditCaptureMode() !== "SIMULATION") {
    return failure("Checkout reuse is available only in Simulation. Return the checked-out bin before starting this preparation.");
  }
  if (isOutOfSimulationScope(selection.binCode)) {
    return { ok: false, requestId, reason: "simulation_scope_violation",
      sourceBinCode: selection.binCode, message: new SimulationScopeError(selection.binCode).message };
  }

  return prisma.$transaction(async (tx) => {
    const bin = await tx.bin.findUnique({
      where: { code: selection.binCode },
      include: {
        inventory: { include: { part: true } },
        movementsFromThisBin: { where: { type: "RETRIEVAL" }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    const stock = bin?.inventory[0];
    if (!bin || bin.status !== "CHECKED_OUT" || bin.inventory.length !== 1
      || !stock || stock.part.sku !== selection.sku || stock.quantity !== selection.recordedQuantity) {
      return failure("The selected checkout bin or its recorded stock changed. Start preparation again using the current inventory. No bin moved.");
    }
    const active = await tx.movement.findFirst({
      where: {
        status: { notIn: [...TERMINAL_MOVEMENT_STATUSES] },
        OR: [{ sourceBinId: bin.id }, { destinationBinId: bin.id }],
      },
    });
    if (active) {
      return failure(`Bin ${bin.code} has an unfinished checkout or return check. Continue that check before preparing more parts. No bin moved.`);
    }
    const checkout = bin.movementsFromThisBin[0];
    if (!checkout || checkout.status !== "COMPLETED" || checkout.partId !== stock.partId
      || checkout.destinationLocation !== RETRIEVAL_DESTINATION || !checkout.gantryOperationId
      || !checkout.verificationImageUrl || !checkout.verificationCapturedAt
      || checkout.newQuantity !== stock.quantity) {
      return failure(`Bin ${bin.code} is already at checkout, but has no completed matching contents check. Request putaway to verify and return it before starting preparation. No bin moved.`);
    }
    return {
      ok: true,
      requestId,
      part: { partId: stock.part.id, sku: stock.part.sku, canonicalName: stock.part.canonicalName },
      sourceBinCode: bin.code,
      destination: RETRIEVAL_DESTINATION,
      movementId: checkout.id,
      gantryOperationId: checkout.gantryOperationId,
      checkedOutQuantity: stock.quantity,
      inventoryQuantityRemoved: 0,
      remainingQuantityInBin: stock.quantity,
      binStatus: "CHECKED_OUT",
      status: "COMPLETED",
      alreadyAtCheckout: true,
    };
  });
}
