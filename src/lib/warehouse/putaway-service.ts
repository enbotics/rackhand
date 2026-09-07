/**
 * Deterministic putaway orchestration (Milestone 7).
 *
 * This is the first code path in the project that changes warehouse state on
 * an agent's request, so the division of labour is the whole design:
 *
 *     the agent REQUESTS a putaway
 *     this service VALIDATES and EXECUTES it
 *     the simulator MOVES
 *     the database COMMITS only after the movement succeeded
 *
 * Nothing here trusts the caller. In particular it does not trust that the
 * agent already called match_catalog and saw MATCHED, or already called
 * list_available_bins and saw B2-01 free. Conversational memory is not
 * authorization: the catalog match is re-run and the bin is re-checked inside
 * the reserving transaction, because warehouse state may have changed in
 * between and a language model's recollection is not evidence.
 *
 * It is callable directly — a route and the test suite both use it without an
 * LLM anywhere in the picture. The Strands tool is a three-line adapter.
 *
 * THE INVARIANT THAT MATTERS MOST: inventory increases only after the gantry
 * reports COMPLETED. The database must never claim a part is on the shelf
 * before it got there.
 */
import { prisma } from "./db";
import { matchScanToCatalog } from "./catalog-matcher";
import { applyInventoryAddition } from "./inventory-service";
import { findAvailableBin, getBinByCode, updateMovementStatus } from "./repository";
import { collectScanResultIssues } from "./scan-result";
import { resolveCatalogIdentity } from "./catalog-identity";
import type { EffectiveCatalogIdentity } from "./catalog-resolution-types";
import {
  PUTAWAY_QUANTITY,
  PUTAWAY_SOURCE,
  type PutawayFailure,
  type PutawayFailureReason,
  type PutawayRequest,
  type PutawayResult,
  type PutawaySuccess,
} from "./putaway-types";
import { getGantryController } from "@/lib/gantry/factory";
import { isGantryError } from "@/lib/gantry/errors";
import type { GantryOperation, WarehouseBinCode } from "@/lib/gantry/types";
import type { Bin, Movement, Part } from "@/generated/prisma/client";

/** One line per state transition. Never logs credentials, images or reasoning. */
function logPutaway(fields: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[putaway] ${fields}`);
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

/** Replays an already-completed putaway without executing anything. */
function replay(movement: Movement, part: Part, binCode: string): PutawaySuccess {
  return {
    ok: true,
    scanId: movement.scanId ?? "",
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    destinationBinCode: binCode,
    movementId: movement.id,
    // The operation that actually moved the part, the first time round.
    gantryOperationId: movement.gantryOperationId ?? "",
    inventoryQuantityAdded: 0,
    status: "COMPLETED",
    identity: { source: "DETERMINISTIC_MATCH", partId: part.id },
    duplicate: true,
  };
}

export async function executePutaway(input: PutawayRequest): Promise<PutawayResult> {
  const scanResult = input?.scanResult;
  const scanId =
    typeof (scanResult as { scanId?: unknown } | undefined)?.scanId === "string"
      ? (scanResult as { scanId: string }).scanId
      : "";

  /* 1 — the scan itself, against the same rules /api/measure applies. */
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    return fail(scanId, "invalid_scan", `The scan is not valid: ${issues.join("; ")}`);
  }

  /* 2 — idempotency. One physical scan, one putaway. */
  const claimed = await prisma.movement.findUnique({ where: { idempotencyKey: scanId } });
  if (claimed) {
    const claimedPart = await prisma.part.findUnique({ where: { id: claimed.partId } });
    const claimedBin = claimed.destinationBinId
      ? await prisma.bin.findUnique({ where: { id: claimed.destinationBinId } })
      : null;

    if (claimed.status === "COMPLETED" && claimedPart) {
      logPutaway(`scan=${scanId} movement=${claimed.id} status=DUPLICATE`);
      return replay(claimed, claimedPart, claimedBin?.code ?? "");
    }
    return fail(
      scanId,
      "putaway_in_progress",
      "This scan is already being put away. Wait for it to finish rather than submitting it again.",
      { movementId: claimed.id },
    );
  }

  /* 3-4 — identity. The matcher is re-run and never taken on trust; a human
     resolution is accepted only for AMBIGUOUS, and is revalidated rather than
     believed because an id was supplied.

     The rules live in catalog-identity.ts so the Milestone 11 putaway graph's
     identity node runs exactly this code rather than a second copy of it. Note
     that the graph resolving identity first changes nothing here: this service
     re-runs the matcher and re-checks the resolution itself, every time. */
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
  const identity: EffectiveCatalogIdentity = resolved.identity;

  const part = await prisma.part.findUnique({ where: { id: identity.partId } });
  if (!part) {
    return fail(
      scanId,
      "part_not_found",
      "The identified part is no longer in the catalog.",
    );
  }

  /* 5-6 — destination. Supplied bins are revalidated exactly like chosen ones. */
  let bin: Bin | null;
  if (input.destinationBinCode !== undefined) {
    bin = await getBinByCode(input.destinationBinCode);
    if (!bin) {
      return fail(scanId, "bin_not_found", `No bin has code "${input.destinationBinCode}".`);
    }
    if (bin.status !== "AVAILABLE") {
      return fail(
        scanId,
        "bin_unavailable",
        `Bin ${bin.code} is ${bin.status}; a putaway target must be AVAILABLE.`,
      );
    }
  } else {
    bin = await findAvailableBin();
    if (!bin) {
      return fail(scanId, "no_available_bin", "No bin is currently AVAILABLE for putaway.");
    }
  }

  // No separate "is this reachable" check: `bin` was just loaded from the Bin
  // table by getBinByCode/findAvailableBin above, so bin.code is by
  // definition a real, current bin code.
  const destination: WarehouseBinCode = bin.code;

  /* 7 — gantry pre-check. Advisory: the authoritative guard is the controller's
     own synchronous claim, handled at step 10. */
  const gantry = getGantryController();
  const status = await gantry.getStatus();
  if (status.state !== "IDLE" || status.activeOperationId !== null) {
    return fail(
      scanId,
      "gantry_busy",
      `The gantry is ${status.state} and cannot start a putaway right now.`,
    );
  }

  /* 8 — CLAIM TRANSACTION. Reserve the bin and create the Movement together,
     so a reserved bin can never exist without the movement that owns it. */
  let movement: Movement;
  try {
    movement = await prisma.$transaction(async (tx) => {
      // Conditional update: the WHERE clause is the lock. Two concurrent
      // requests cannot both match status "AVAILABLE".
      const reserved = await tx.bin.updateMany({
        where: { id: bin.id, status: "AVAILABLE" },
        data: { status: "RESERVED" },
      });
      if (reserved.count !== 1) {
        throw new PutawayClaimError(
          "bin_reservation_conflict",
          `Bin ${destination} was taken by another operation before this putaway could reserve it.`,
        );
      }

      // Belt and braces: an AVAILABLE bin should already be empty.
      const occupied = await tx.inventory.count({ where: { binId: bin.id } });
      if (occupied > 0) {
        throw new PutawayClaimError(
          "bin_unavailable",
          `Bin ${destination} still holds stock and cannot receive a putaway.`,
        );
      }

      return tx.movement.create({
        data: {
          type: "PUTAWAY",
          partId: part.id,
          quantity: PUTAWAY_QUANTITY,
          status: "VALIDATED",
          destinationBinId: bin.id,
          sourceLocation: PUTAWAY_SOURCE,
          scanId,
          idempotencyKey: scanId,
        },
      });
    });
  } catch (err) {
    if (err instanceof PutawayClaimError) return fail(scanId, err.reason, err.message);
    // A unique violation here means a concurrent request claimed this scan
    // between the step-2 read and now; the transaction rolled the bin back.
    if (isUniqueViolation(err)) {
      return fail(
        scanId,
        "putaway_in_progress",
        "This scan was claimed by another putaway request. Nothing was executed twice.",
      );
    }
    throw err;
  }

  logPutaway(
    `scan=${scanId} match=${part.sku} identity=${identity.source} destination=${destination} movement=${movement.id} status=VALIDATED`,
  );

  /* 9-10 — run the machine. */
  let operation: GantryOperation;
  try {
    await updateMovementStatus(movement.id, "RUNNING");
    logPutaway(`movement=${movement.id} destination=${destination} status=RUNNING`);
    operation = await gantry.putaway({ source: PUTAWAY_SOURCE, destination });
  } catch (err) {
    // Includes the controller's own gantry_busy, which beats the step-7 check
    // when two requests arrive together.
    const busy = isGantryError(err) && err.code === "gantry_busy";
    await releaseClaim(movement.id, bin.id);
    if (busy) {
      return fail(scanId, "gantry_busy", "The gantry became busy before this putaway could start.", {
        movementId: movement.id,
      });
    }
    throw err;
  }

  if (operation.status !== "COMPLETED") {
    await releaseClaim(movement.id, bin.id, operation.operationId);
    logPutaway(
      `movement=${movement.id} gantry=${operation.operationId} status=FAILED reason=${operation.error ?? "unknown"}`,
    );
    return fail(scanId, "gantry_failed", `The gantry did not complete the putaway.`, {
      movementId: movement.id,
      gantryOperationId: operation.operationId,
      error: operation.error ?? undefined,
    });
  }

  /* 11 — COMMIT TRANSACTION. The three warehouse facts move together or not
     at all: stock exists, the bin is occupied, the movement is complete. */
  try {
    await prisma.$transaction(async (tx) => {
      await applyInventoryAddition(tx, part, { ...bin, status: "AVAILABLE" }, PUTAWAY_QUANTITY);
      await tx.bin.update({ where: { id: bin.id }, data: { status: "OCCUPIED" } });
      await tx.movement.update({
        where: { id: movement.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          gantryOperationId: operation.operationId,
        },
      });
    });
  } catch (err) {
    // The part IS physically in the bin. Claiming failure would be a lie, and
    // re-running the gantry would move it twice, so we do neither: the
    // movement stays RUNNING, the ids are preserved, and a human reconciles.
    console.error(
      `[putaway] INCONSISTENT movement=${movement.id} gantry=${operation.operationId} ` +
        `bin=${destination} sku=${part.sku} — gantry completed but the database commit failed. ` +
        `The part is physically in the bin; inventory does NOT reflect it.`,
      err,
    );
    return fail(
      scanId,
      "putaway_commit_failed",
      "The gantry completed the move but the warehouse database could not be updated. " +
        "The part is in the bin; inventory has not been updated. This needs manual reconciliation.",
      { movementId: movement.id, gantryOperationId: operation.operationId },
    );
  }

  logPutaway(`movement=${movement.id} gantry=${operation.operationId} status=COMPLETED`);

  return {
    ok: true,
    scanId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    destinationBinCode: destination,
    movementId: movement.id,
    gantryOperationId: operation.operationId,
    inventoryQuantityAdded: PUTAWAY_QUANTITY,
    status: "COMPLETED",
    identity,
  };
}

/* ------------------------------------------------------------- internals */

/** Thrown inside the claim transaction so the whole claim rolls back together. */
class PutawayClaimError extends Error {
  constructor(
    readonly reason: PutawayFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PutawayClaimError";
  }
}

function isUniqueViolation(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { code?: unknown }).code === "P2002"
  );
}

/**
 * Undoes a claim that never resulted in stock: the movement becomes FAILED and
 * the bin goes back to AVAILABLE.
 *
 * The idempotency key is cleared, deliberately. A failed putaway must not lock
 * the operator out of retrying the same physical item — but `scanId` is kept,
 * so the failed attempt remains in the movement history and is still traceable
 * to the scan that caused it.
 *
 * The bin is released conditionally, only while it is still RESERVED, so this
 * can never steal a bin some later operation has legitimately taken.
 */
async function releaseClaim(
  movementId: string,
  binId: string,
  gantryOperationId?: string,
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
      data: { status: "AVAILABLE" },
    });
  });
}
