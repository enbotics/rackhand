/**
 * Authoritative putaway and checked-out-bin reconciliation.
 *
 * The model supplies neither the scan, photo nor quantity. A normal putaway
 * adds camera-counted units to a compatible shelf bin. Returning a CHECKED_OUT
 * bin replaces its preserved baseline with the newly observed count.
 */
import { prisma } from "./db";
import { matchScanToCatalog } from "./catalog-matcher";
import { resolveCatalogIdentity } from "./catalog-identity";
import { applyInventoryAddition } from "./inventory-service";
import { evaluatePutawayDestination } from "./putaway-destination";
import { getBinByCode, listPutawayDestinations, updateMovementStatus } from "./repository";
import { collectScanResultIssues } from "./scan-result";
import { uploadPutawayPhoto } from "./storage";
import {
  MIN_PUTAWAY_QUANTITY_CONFIDENCE,
  PUTAWAY_RETURN_SOURCE,
  PUTAWAY_SOURCE,
  type PutawayFailure,
  type PutawayFailureReason,
  type PutawayRequest,
  type PutawayResult,
  type PutawaySuccess,
} from "./putaway-types";
import type { BinStatus } from "./types";
import { getGantryController } from "@/lib/gantry/factory";
import { isGantryError } from "@/lib/gantry/errors";
import type { GantryOperation, WarehouseBinCode } from "@/lib/gantry/types";
import type { Bin, Movement, Part } from "@/generated/prisma/client";
import { compareBinsInShelfOrder } from "./bin-layout";

function logPutaway(fields: string): void {
  if (process.env.NODE_ENV !== "test") console.log(`[putaway] ${fields}`);
}

function fail(
  scanId: string,
  reason: PutawayFailureReason,
  message: string,
  extra: Partial<PutawayFailure> = {},
): PutawayFailure {
  logPutaway(`scan=${scanId} status=REJECTED reason=${reason}`);
  return { ok: false, reason, scanId, message, ...extra };
}

function replay(movement: Movement, part: Part, binCode: string): PutawaySuccess {
  const before = movement.previousQuantity ?? 0;
  const after = movement.newQuantity ?? before + movement.quantity;
  return {
    ok: true,
    scanId: movement.scanId ?? "",
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    destinationBinCode: binCode,
    movementId: movement.id,
    gantryOperationId: movement.gantryOperationId ?? "",
    observedQuantity: movement.quantity,
    inventoryQuantityBefore: before,
    inventoryQuantityAfter: after,
    inventoryQuantityAdded: 0,
    inventoryQuantityRemoved: 0,
    inventoryQuantityDelta: 0,
    reconciledCheckout: movement.sourceLocation === PUTAWAY_RETURN_SOURCE,
    imageUrl: movement.imageUrl ?? "",
    status: "COMPLETED",
    identity: { source: "DETERMINISTIC_MATCH", partId: part.id },
    duplicate: true,
  };
}

interface DestinationPlan {
  bin: Bin;
  baselineQuantity: number;
  destinationBaselineQuantity: number;
  checkedOutReturn: boolean;
  checkedOutBin: Bin | null;
}

async function binContents(binId: string): Promise<Array<{ partId: string; quantity: number }>> {
  return prisma.inventory.findMany({
    where: { binId, quantity: { gt: 0 } },
    select: { partId: true, quantity: true },
  });
}

async function planDestination(
  scanId: string,
  part: Part,
  observedQuantity: number,
  requestedCode?: string,
): Promise<DestinationPlan | PutawayFailure> {
  let bin: Bin | null = null;
  const checkedOutBins = await prisma.bin.findMany({
    where: {
      status: "CHECKED_OUT",
      inventory: { some: { partId: part.id, quantity: { gt: 0 } } },
    },
  });
  const checkedOutBin = checkedOutBins.sort(compareBinsInShelfOrder)[0] ?? null;

  if (requestedCode !== undefined) {
    bin = await getBinByCode(requestedCode);
    if (!bin) return fail(scanId, "bin_not_found", `No bin has code "${requestedCode}".`);
  } else {
    // The physical bin that was checked out is always the default return
    // destination for its part. A different compatible bin remains explicit.
    bin = checkedOutBin;

    if (bin && observedQuantity > bin.capacity) {
      const destinations = await listPutawayDestinations(part.id, observedQuantity);
      const emptyDestination = destinations.find(
        (candidate) => candidate.eligible && candidate.status === "AVAILABLE" && candidate.currentQuantity === 0,
      );
      bin = emptyDestination ? await getBinByCode(emptyDestination.code) : null;
      if (!bin) {
        return fail(
          scanId,
          "no_available_bin",
          `The checked-out home slot cannot hold ${observedQuantity} units and no empty compatible slot is available.`,
        );
      }
    } else if (!bin) {
      const destinations = await listPutawayDestinations(part.id, observedQuantity);
      const chosen =
        destinations.find((candidate) => candidate.eligible && candidate.alreadyStoresPart) ??
        destinations.find((candidate) => candidate.eligible);
      if (!chosen) {
        return fail(
          scanId,
          "no_available_bin",
          `No compatible bin has capacity for ${observedQuantity} ${part.sku}.`,
        );
      }
      bin = await getBinByCode(chosen.code);
    }
  }

  if (!bin) return fail(scanId, "bin_not_found", "The selected destination no longer exists.");
  const contents = await binContents(bin.id);
  const baselineQuantity = contents.reduce((sum, row) => sum + row.quantity, 0);

  if (bin.status === "CHECKED_OUT") {
    if (contents.length === 0 || contents.some((row) => row.partId !== part.id)) {
      return fail(
        scanId,
        "inventory_conflict",
        `Checked-out bin ${bin.code} has no preserved baseline for ${part.sku}.`,
      );
    }
    if (observedQuantity > bin.capacity) {
      return fail(
        scanId,
        "bin_capacity_exceeded",
        `Bin ${bin.code} holds at most ${bin.capacity}; the camera counted ${observedQuantity}.`,
      );
    }
    return {
      bin,
      baselineQuantity,
      destinationBaselineQuantity: baselineQuantity,
      checkedOutReturn: true,
      checkedOutBin: bin,
    };
  }

  if (checkedOutBin) {
    const checkedOutContents = await binContents(checkedOutBin.id);
    const checkedOutBaseline = checkedOutContents.reduce((sum, row) => sum + row.quantity, 0);
    if (
      checkedOutContents.length === 0 ||
      checkedOutContents.some((row) => row.partId !== part.id)
    ) {
      return fail(
        scanId,
        "inventory_conflict",
        `Checked-out bin ${checkedOutBin.code} has no preserved baseline for ${part.sku}.`,
      );
    }
    if (bin.status !== "AVAILABLE" || baselineQuantity !== 0 || observedQuantity > bin.capacity) {
      return fail(
        scanId,
        observedQuantity > bin.capacity ? "bin_capacity_exceeded" : "bin_unavailable",
        `Alternate return slot ${bin.code} must be empty, AVAILABLE and able to hold ${observedQuantity} units.`,
      );
    }
    return {
      bin,
      baselineQuantity: checkedOutBaseline,
      destinationBaselineQuantity: 0,
      checkedOutReturn: true,
      checkedOutBin,
    };
  }

  const evaluation = evaluatePutawayDestination(
    { ...bin, status: bin.status as BinStatus, contents },
    part.id,
    observedQuantity,
  );
  if (!evaluation.eligible) {
    const reason = evaluation.reason === "FULL" ? "bin_capacity_exceeded" : "bin_unavailable";
    return fail(
      scanId,
      reason,
      evaluation.reason === "FULL"
        ? `Bin ${bin.code} has capacity ${bin.capacity}; ${baselineQuantity} are stored and ${observedQuantity} more will not fit.`
        : `Bin ${bin.code} is not compatible (${evaluation.reason}).`,
    );
  }
  return {
    bin,
    baselineQuantity,
    destinationBaselineQuantity: baselineQuantity,
    checkedOutReturn: false,
    checkedOutBin: null,
  };
}

export async function executePutaway(input: PutawayRequest): Promise<PutawayResult> {
  const scanResult = input?.scanResult;
  const scanId =
    typeof (scanResult as { scanId?: unknown } | undefined)?.scanId === "string"
      ? (scanResult as { scanId: string }).scanId
      : "";

  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    return fail(scanId, "invalid_scan", `The scan is not valid: ${issues.join("; ")}`);
  }

  // Idempotent replay needs no fresh photo or gantry readiness: it reports the
  // already committed operation and cannot move anything again.
  const claimed = await prisma.movement.findUnique({ where: { idempotencyKey: scanId } });
  if (claimed) {
    const [claimedPart, claimedBin] = await Promise.all([
      prisma.part.findUnique({ where: { id: claimed.partId } }),
      claimed.destinationBinId
        ? prisma.bin.findUnique({ where: { id: claimed.destinationBinId } })
        : null,
    ]);
    if (claimed.status === "COMPLETED" && claimedPart) {
      logPutaway(`scan=${scanId} movement=${claimed.id} status=DUPLICATE`);
      return replay(claimed, claimedPart, claimedBin?.code ?? "");
    }
    return fail(scanId, "putaway_in_progress", "This scan already has a putaway in progress.", {
      movementId: claimed.id,
    });
  }

  const imageDataUrl = typeof input.imageDataUrl === "string" ? input.imageDataUrl : "";
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageDataUrl)) {
    return fail(scanId, "photo_required", "A fresh automatic camera photo is required before putaway.");
  }

  const observedQuantity = scanResult.quantity?.observed ?? 1;
  const quantityConfidence = scanResult.quantity?.confidence ?? 1;
  if (!Number.isInteger(observedQuantity) || observedQuantity < 1) {
    return fail(scanId, "invalid_scan", "The camera quantity must be a positive whole number.");
  }
  if (quantityConfidence < MIN_PUTAWAY_QUANTITY_CONFIDENCE) {
    return fail(
      scanId,
      "quantity_confidence_low",
      `Quantity confidence is ${Math.round(quantityConfidence * 100)}%; at least ${Math.round(MIN_PUTAWAY_QUANTITY_CONFIDENCE * 100)}% is required before movement.`,
    );
  }

  const match = await matchScanToCatalog(scanResult);
  const resolved = await resolveCatalogIdentity({
    scanId,
    match,
    catalogResolutionId: input.catalogResolutionId,
  });
  if (!resolved.ok) {
    return fail(
      scanId,
      resolved.reason,
      resolved.message,
      resolved.candidates ? { candidates: resolved.candidates } : {},
    );
  }
  const part = await prisma.part.findUnique({ where: { id: resolved.identity.partId } });
  if (!part) return fail(scanId, "part_not_found", "The identified part is no longer in the catalog.");

  const planned = await planDestination(scanId, part, observedQuantity, input.destinationBinCode);
  if (!("bin" in planned)) return planned;
  const {
    bin,
    baselineQuantity,
    destinationBaselineQuantity,
    checkedOutReturn,
    checkedOutBin,
  } = planned;
  const relocatingCheckout =
    checkedOutReturn && checkedOutBin !== null && checkedOutBin.id !== bin.id;
  const destination: WarehouseBinCode = bin.code;

  const gantry = getGantryController();
  const status = await gantry.getStatus();
  if (status.state !== "IDLE" || status.activeOperationId !== null) {
    return fail(scanId, "gantry_busy", `The gantry is ${status.state} and cannot start a putaway.`);
  }

  let movement: Movement;
  try {
    movement = await prisma.$transaction(async (tx) => {
      const reserved = await tx.bin.updateMany({
        where: { id: bin.id, status: bin.status },
        data: { status: "RESERVED" },
      });
      if (reserved.count !== 1) {
        throw new PutawayClaimError("bin_reservation_conflict", `Bin ${bin.code} was claimed concurrently.`);
      }

      if (relocatingCheckout) {
        const sourceReserved = await tx.bin.updateMany({
          where: { id: checkedOutBin!.id, status: "CHECKED_OUT" },
          data: { status: "RESERVED" },
        });
        if (sourceReserved.count !== 1) {
          throw new PutawayClaimError(
            "bin_reservation_conflict",
            `Checked-out bin ${checkedOutBin!.code} changed before it could be returned.`,
          );
        }
      }

      const freshContents = await tx.inventory.findMany({
        where: { binId: bin.id, quantity: { gt: 0 } },
        select: { partId: true, quantity: true },
      });
      const freshBaseline = freshContents.reduce((sum, row) => sum + row.quantity, 0);
      if (
        freshBaseline !== destinationBaselineQuantity ||
        freshContents.some((row) => row.partId !== part.id)
      ) {
        throw new PutawayClaimError("inventory_conflict", `Inventory in ${bin.code} changed before reservation.`);
      }
      if (checkedOutReturn) {
        const sourceInventory = await tx.inventory.findUnique({
          where: { partId_binId: { partId: part.id, binId: checkedOutBin!.id } },
        });
        if (
          !sourceInventory ||
          sourceInventory.quantity !== baselineQuantity ||
          observedQuantity > bin.capacity
        ) {
          throw new PutawayClaimError("bin_unavailable", `Checked-out bin ${bin.code} cannot be returned safely.`);
        }
      } else {
        const freshEvaluation = evaluatePutawayDestination(
          { ...bin, status: bin.status as BinStatus, contents: freshContents },
          part.id,
          observedQuantity,
        );
        if (!freshEvaluation.eligible) {
          throw new PutawayClaimError(
            freshEvaluation.reason === "FULL" ? "bin_capacity_exceeded" : "bin_unavailable",
            `Bin ${bin.code} is no longer compatible (${freshEvaluation.reason}).`,
          );
        }
      }

      return tx.movement.create({
        data: {
          type: "PUTAWAY",
          partId: part.id,
          quantity: observedQuantity,
          status: "VALIDATED",
          destinationBinId: bin.id,
          sourceBinId: relocatingCheckout ? checkedOutBin!.id : undefined,
          sourceLocation: checkedOutReturn ? PUTAWAY_RETURN_SOURCE : PUTAWAY_SOURCE,
          scanId,
          idempotencyKey: scanId,
          previousQuantity: baselineQuantity,
          newQuantity: checkedOutReturn ? observedQuantity : baselineQuantity + observedQuantity,
        },
      });
    });
  } catch (error) {
    if (error instanceof PutawayClaimError) return fail(scanId, error.reason, error.message);
    if (isUniqueViolation(error)) {
      return fail(scanId, "putaway_in_progress", "This scan was claimed by another putaway request.");
    }
    throw error;
  }

  let imageUrl: string;
  try {
    imageUrl = await uploadPutawayPhoto(scanId, imageDataUrl);
    await prisma.movement.update({ where: { id: movement.id }, data: { imageUrl } });
  } catch (error) {
    await releaseClaim(movement.id, bin.id, bin.status, undefined, relocatingCheckout ? checkedOutBin : null);
    console.error(`[putaway] photo upload failed scan=${scanId} movement=${movement.id}`, error);
    return fail(
      scanId,
      "photo_upload_failed",
      "The verification photo could not be stored, so the gantry did not move.",
      { movementId: movement.id },
    );
  }

  logPutaway(
    `scan=${scanId} match=${part.sku} count=${observedQuantity} destination=${destination} return=${checkedOutReturn} movement=${movement.id} status=VALIDATED`,
  );

  let operation: GantryOperation;
  try {
    await updateMovementStatus(movement.id, "RUNNING");
    operation = checkedOutReturn
      ? await gantry.returnBin({ source: PUTAWAY_RETURN_SOURCE, destination })
      : await gantry.putaway({ source: PUTAWAY_SOURCE, destination });
  } catch (error) {
    const busy = isGantryError(error) && error.code === "gantry_busy";
    await releaseClaim(movement.id, bin.id, bin.status, undefined, relocatingCheckout ? checkedOutBin : null);
    if (busy) {
      return fail(scanId, "gantry_busy", "The gantry became busy before putaway started.", {
        movementId: movement.id,
      });
    }
    console.error(`[putaway] gantry failed scan=${scanId} movement=${movement.id}`, error);
    return fail(scanId, "gantry_failed", "The gantry could not complete the putaway.", {
      movementId: movement.id,
      error: isGantryError(error) ? error.message : undefined,
    });
  }

  if (operation.status !== "COMPLETED") {
    await releaseClaim(
      movement.id,
      bin.id,
      bin.status,
      operation.operationId,
      relocatingCheckout ? checkedOutBin : null,
    );
    return fail(scanId, "gantry_failed", "The gantry did not complete the putaway.", {
      movementId: movement.id,
      gantryOperationId: operation.operationId,
      error: operation.error ?? undefined,
    });
  }

  const inventoryAfter = checkedOutReturn ? observedQuantity : baselineQuantity + observedQuantity;
  try {
    await prisma.$transaction(async (tx) => {
      if (checkedOutReturn) {
        const existing = await tx.inventory.findUnique({
          where: { partId_binId: { partId: part.id, binId: checkedOutBin!.id } },
        });
        if (!existing || existing.quantity !== baselineQuantity) {
          throw new Error("checked-out inventory baseline changed after physical return");
        }
        if (relocatingCheckout) {
          await tx.inventory.delete({ where: { id: existing.id } });
          await tx.inventory.create({
            data: { partId: part.id, binId: bin.id, quantity: observedQuantity },
          });
          const releasedSource = await tx.bin.updateMany({
            where: { id: checkedOutBin!.id, status: "RESERVED" },
            data: { status: "AVAILABLE" },
          });
          if (releasedSource.count !== 1) {
            throw new Error("checked-out source reservation was lost after physical return");
          }
        } else {
          await tx.inventory.update({ where: { id: existing.id }, data: { quantity: observedQuantity } });
        }
      } else {
        await applyInventoryAddition(tx, part, bin, observedQuantity);
      }
      const committedBin = await tx.bin.updateMany({
        where: { id: bin.id, status: "RESERVED" },
        data: { status: inventoryAfter > 0 ? "OCCUPIED" : "AVAILABLE" },
      });
      if (committedBin.count !== 1) {
        throw new Error("putaway reservation was lost after physical movement");
      }
      await tx.movement.update({
        where: { id: movement.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          gantryOperationId: operation.operationId,
          imageUrl,
          verificationImageUrl: imageUrl,
          verificationCapturedAt: new Date(),
          previousQuantity: baselineQuantity,
          newQuantity: inventoryAfter,
        },
      });
    });
  } catch (error) {
    console.error(
      `[putaway] INCONSISTENT movement=${movement.id} gantry=${operation.operationId} bin=${destination} sku=${part.sku}`,
      error,
    );
    return fail(
      scanId,
      "putaway_commit_failed",
      "The gantry completed the move but database reconciliation failed. Manual reconciliation is required.",
      { movementId: movement.id, gantryOperationId: operation.operationId },
    );
  }

  const delta = inventoryAfter - baselineQuantity;
  logPutaway(`movement=${movement.id} gantry=${operation.operationId} status=COMPLETED quantity=${inventoryAfter}`);
  return {
    ok: true,
    scanId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    destinationBinCode: destination,
    movementId: movement.id,
    gantryOperationId: operation.operationId,
    observedQuantity,
    inventoryQuantityBefore: baselineQuantity,
    inventoryQuantityAfter: inventoryAfter,
    inventoryQuantityAdded: Math.max(0, delta),
    inventoryQuantityRemoved: Math.max(0, -delta),
    inventoryQuantityDelta: delta,
    reconciledCheckout: checkedOutReturn,
    imageUrl,
    status: "COMPLETED",
    identity: resolved.identity,
  };
}

class PutawayClaimError extends Error {
  constructor(readonly reason: PutawayFailureReason, message: string) {
    super(message);
    this.name = "PutawayClaimError";
  }
}

function isUniqueViolation(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "P2002";
}

async function releaseClaim(
  movementId: string,
  binId: string,
  originalStatus: string,
  gantryOperationId?: string,
  checkedOutSource?: Bin | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.movement.update({
      where: { id: movementId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        idempotencyKey: null,
        ...(gantryOperationId ? { gantryOperationId } : {}),
      },
    });
    await tx.bin.updateMany({
      where: { id: binId, status: "RESERVED" },
      data: { status: originalStatus },
    });
    if (checkedOutSource && checkedOutSource.id !== binId) {
      await tx.bin.updateMany({
        where: { id: checkedOutSource.id, status: "RESERVED" },
        data: { status: "CHECKED_OUT" },
      });
    }
  });
}
