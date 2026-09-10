/**
 * Deterministic retrieval orchestration (Milestone 8).
 *
 * The mirror of PutawayService, and the same division of labour:
 *
 *     the agent REQUESTS a retrieval
 *     this service VALIDATES and EXECUTES it
 *     the simulator MOVES
 *     the database marks the entire bin CHECKED_OUT only after movement succeeds
 *
 * Nothing here trusts the caller. It does not trust that the agent already
 * called search_inventory and saw two in B2-01 — inventory is re-queried, and
 * the source bin is claimed conditionally, so concurrent operations cannot
 * move it twice even if the world changed underneath the model's recollection.
 *
 * It is callable directly: a route, a demo script and the test suite all use
 * it with no LLM in the picture.
 *
 * THE INVARIANT THAT MATTERS MOST: checking out a whole bin does not guess how
 * many items a client removes. The last verified quantity remains recorded but
 * unavailable until photographed return putaway reconciles it.
 */
import { prisma } from "./db";
import { getInventoryByBin, getInventoryForPart } from "./inventory-service";
import { getBinByCode, getPartById, getPartBySku, updateMovementStatus } from "./repository";
import {
  RETRIEVAL_DESTINATION,
  type RetrievalFailure,
  type RetrievalFailureReason,
  type RetrievalRequest,
  type RetrievalResult,
  type RetrievalSuccess,
} from "./retrieval-types";
import { getGantryController } from "@/lib/gantry/factory";
import { isGantryError } from "@/lib/gantry/errors";
import type { GantryOperation, WarehouseBinCode } from "@/lib/gantry/types";
import type { Movement } from "@/generated/prisma/client";
import { compareBinsInShelfOrder } from "./bin-layout";
import { isOutOfSimulationScope, SIMULATION_ELIGIBLE_BINS } from "./audit-capture-mode";
import { requireRetrievalVerification } from "./retrieval-verification";

/**
 * Retrieval and putaway share one `Movement.idempotencyKey` column, so the
 * keys are namespaced. A putaway is claimed by its scanId; without a prefix a
 * retrieval requestId that happened to look like a scanId could collide with
 * one and silently "replay" an unrelated operation.
 */
export const RETRIEVAL_IDEMPOTENCY_PREFIX = "retrieval:";

/** `retrieval_<timestamp>_<random>` — same shape as scan and gantry ids. */
export function createRetrievalRequestId(): string {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `retrieval_${Date.now()}_${suffix}`;
}

/**
 * POLICY: first stocked bin in the warehouse's physical shelf order.
 * Deterministic on purpose — neither the model nor the graph picks a source
 * bin by a different ordering rule.
 */
export function chooseRetrievalSourceBinCode(
  stocked: readonly { binCode: string; quantity: number }[],
): string | null {
  return [...stocked].sort((left, right) =>
    compareBinsInShelfOrder({ code: left.binCode }, { code: right.binCode }),
  )[0]?.binCode ?? null;
}

/** One line per state transition. Never logs credentials, images or reasoning. */
function logRetrieval(fields: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[retrieval] ${fields}`);
}

function fail(
  requestId: string,
  reason: RetrievalFailureReason,
  message: string,
  extra: Partial<RetrievalFailure> = {},
): RetrievalFailure {
  logRetrieval(`request=${requestId} status=REJECTED reason=${reason}`);
  return { ok: false, reason, requestId, message, ...extra };
}

export async function executeRetrieval(input: RetrievalRequest): Promise<RetrievalResult> {
  const requestId = input?.requestId?.trim() || createRetrievalRequestId();
  const idempotencyKey = `${RETRIEVAL_IDEMPOTENCY_PREFIX}${requestId}`;

  /* 1 — the request itself. At most one of sku/partId — accepting both
     would need a precedence rule the caller cannot see, and a request
     naming two different parts is a mistake worth reporting. Neither is
     required: a bin ALONE is itself authoritative identity (see the
     RetrievalRequest doc comment), so a request needs sku, partId, or a
     sourceBinCode to identify by — never none of the three. */
  let sku = typeof input?.sku === "string" ? input.sku.trim() : "";
  let partId = typeof input?.partId === "string" ? input.partId.trim() : "";
  const requestedBinCode = typeof input?.sourceBinCode === "string" ? input.sourceBinCode.trim().toUpperCase() : "";
  if (sku && partId) {
    return fail(requestId, "invalid_request", "Provide at most one of sku or partId, not both.");
  }
  if (!sku && !partId && !requestedBinCode) {
    return fail(
      requestId,
      "invalid_request",
      "Provide a sku, a partId, or a sourceBinCode to identify what to retrieve.",
    );
  }

  /* 2 — idempotency. One request id, one physical retrieval. */
  const claimed = await prisma.movement.findUnique({ where: { idempotencyKey } });
  if (claimed) {
    return replayOrReject(claimed, requestId);
  }

  /* 2.5 — bin-only identity: the bin IS the identity, resolved from its own
     contents rather than asked for separately — a bin holds at most one
     SKU, the same invariant get_bin_status already relies on, so this is
     never a guess. Falls through to the sku/partId path below with sku now
     populated, which naturally re-validates this exact bin still holds it. */
  if (!sku && !partId) {
    const bin = await getBinByCode(requestedBinCode);
    if (!bin) {
      return fail(requestId, "source_bin_not_found", `No bin has code "${requestedBinCode}".`);
    }
    const [holding] = (await getInventoryByBin(bin.code)).filter((row) => row.quantity > 0);
    if (!holding) {
      return fail(
        requestId,
        "source_bin_empty",
        `Bin ${bin.code} is empty; there is nothing to retrieve.`,
        { sourceBinCode: bin.code },
      );
    }
    sku = holding.sku;
  }

  /* 3 — authoritative catalog identity. Never a name the model liked. */
  const part = sku ? await getPartBySku(sku) : await getPartById(partId);
  if (!part) {
    return fail(
      requestId,
      "part_not_found",
      `No catalog part matches ${sku ? `SKU "${sku}"` : `id "${partId}"`}. ` +
        "This is different from having none in stock.",
    );
  }

  /* 4-5 — fresh inventory, re-queried rather than remembered. */
  const summary = await getInventoryForPart(part.sku);
  if (summary.totalQuantity <= 0) {
    return fail(
      requestId,
      "out_of_stock",
      `${part.sku} is in the catalog but no bin currently holds any stock of it.`,
      { partId: part.id },
    );
  }

  /* 6 — source bin. Supplied bins are validated exactly like chosen ones. */
  const stocked = summary.locations.filter(
    (location) => location.quantity > 0 && location.binStatus === "OCCUPIED",
  );
  let sourceBinCode: string;

  if (input.sourceBinCode !== undefined) {
    const requested = input.sourceBinCode.trim().toUpperCase();
    const bin = await getBinByCode(requested);
    if (!bin) {
      return fail(requestId, "source_bin_not_found", `No bin has code "${requested}".`);
    }
    const holding = stocked.find((location) => location.binCode === bin.code);
    if (!holding) {
      return fail(
        requestId,
        "source_inventory_mismatch",
        `Bin ${bin.code} does not hold any ${part.sku}. It is stocked in: ` +
          `${stocked.map((l) => `${l.binCode} (${l.quantity})`).join(", ")}.`,
        { partId: part.id },
      );
    }
    sourceBinCode = bin.code;
  } else {
    // The policy lives in one exported function so the Milestone 11 retrieval
    // graph selects the same bin this service would, rather than inventing its
    // own strategy that happens to agree today.
    const chosen = chooseRetrievalSourceBinCode(stocked);
    if (!chosen) {
      return fail(
        requestId,
        "out_of_stock",
        `${part.sku} is in the catalog but no bin currently holds any stock of it.`,
        { partId: part.id },
      );
    }
    sourceBinCode = chosen;
  }

  // No separate "is this reachable" check: sourceBinCode always comes from a
  // Bin row (or a stocked location derived from one) just read above.
  const source: WarehouseBinCode = sourceBinCode;

  // Refuse before touching bin/gantry state: Simulation mode must never
  // silently run a real retrieval on a bin it doesn't cover, same guard as
  // audit and putaway verification.
  if (isOutOfSimulationScope(source)) {
    return fail(
      requestId,
      "simulation_scope_violation",
      `Bin ${source} is not simulation-eligible (only ${SIMULATION_ELIGIBLE_BINS.join(", ")} are). ` +
        "Switch Audit Capture Mode to Prod to retrieve from this bin.",
      { partId: part.id, sourceBinCode: source },
    );
  }

  const sourceBin = await getBinByCode(source);
  if (!sourceBin) {
    return fail(requestId, "source_bin_not_found", `No bin has code "${source}".`);
  }
  if (sourceBin.status !== "OCCUPIED") {
    return fail(
      requestId,
      "inventory_conflict",
      `Bin ${source} is ${sourceBin.status}; only a bin physically on the shelf can be checked out.`,
      { partId: part.id, sourceBinCode: source },
    );
  }
  const sourceQuantityBefore =
    stocked.find((location) => location.binCode === source)?.quantity ?? 0;

  /* 7 — select the configured controller. Simulation does not require a
     separate IDLE preflight; the operation itself owns execution state. */
  const gantry = getGantryController();

  /* 8 — atomically claim the bin and record the full last-verified count. */
  let movement: Movement;
  try {
    movement = await prisma.$transaction(async (tx) => {
      const reserved = await tx.bin.updateMany({
        where: { id: sourceBin.id, status: "OCCUPIED" },
        data: { status: "RESERVED" },
      });
      if (reserved.count !== 1) throw new Error("bin_checkout_conflict");
      const stock = await tx.inventory.findUnique({
        where: { partId_binId: { partId: part.id, binId: sourceBin.id } },
      });
      if (!stock || stock.quantity !== sourceQuantityBefore) {
        throw new Error("bin_checkout_conflict");
      }
      return tx.movement.create({
        data: {
          type: "RETRIEVAL",
          partId: part.id,
          quantity: sourceQuantityBefore,
          status: "VALIDATED",
          sourceBinId: sourceBin.id,
          destinationLocation: RETRIEVAL_DESTINATION,
          idempotencyKey,
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.movement.findUnique({ where: { idempotencyKey } });
      if (existing) return replayOrReject(existing, requestId);
    }
    if (err instanceof Error && err.message === "bin_checkout_conflict") {
      return fail(
        requestId,
        "inventory_conflict",
        `Bin ${source} changed before it could be checked out. Nothing moved.`,
        { partId: part.id, sourceBinCode: source },
      );
    }
    throw err;
  }

  logRetrieval(
    `request=${requestId} part=${part.sku} source=${source} movement=${movement.id} status=VALIDATED`,
  );

  /* 9 — run the machine. */
  let operation: GantryOperation;
  try {
    await updateMovementStatus(movement.id, "RUNNING");
    logRetrieval(`movement=${movement.id} source=${source} status=RUNNING`);
    operation = await gantry.retrieve({ source, destination: RETRIEVAL_DESTINATION });
  } catch (err) {
    const busy = isGantryError(err) && err.code === "gantry_busy";
    await releaseClaim(movement.id, sourceBin.id);
    if (busy) {
      return fail(
        requestId,
        "gantry_busy",
        "The gantry became busy before this retrieval could start.",
        { movementId: movement.id, partId: part.id, sourceBinCode: source },
      );
    }
    console.error(`[retrieval] gantry failed request=${requestId} movement=${movement.id}`, err);
    return fail(requestId, "gantry_failed", "The gantry could not complete the retrieval.", {
      movementId: movement.id,
      partId: part.id,
      sourceBinCode: source,
      error: isGantryError(err) ? err.message : undefined,
    });
  }

  if (operation.status !== "COMPLETED") {
    // The item is still assumed to be where it was: nothing left the bin.
    await releaseClaim(movement.id, sourceBin.id, operation.operationId);
    logRetrieval(
      `movement=${movement.id} gantry=${operation.operationId} status=FAILED reason=${operation.error ?? "unknown"}`,
    );
    return fail(requestId, "gantry_failed", "The gantry did not complete the retrieval.", {
      movementId: movement.id,
      gantryOperationId: operation.operationId,
      partId: part.id,
      sourceBinCode: source,
      error: operation.error ?? undefined,
    });
  }

  /* 9.5 — verify what's actually in the bin before the checkout is final.
     The gantry already carried it to OUTPUT (the shelf itself is never
     camera-visible); a failed verification sends it back rather than
     completing the checkout. */
  let verification: Awaited<ReturnType<typeof requireRetrievalVerification>>;
  try {
    verification = await requireRetrievalVerification(movement.id);
  } catch (err) {
    console.error(
      `[retrieval] verification failed request=${requestId} movement=${movement.id}`,
      err,
    );
    try {
      // The bin already physically moved to OUTPUT — send it back before
      // reverting any DB state, so a failed verification never silently
      // completes a checkout nobody confirmed.
      const returned = await gantry.returnBin({ source: RETRIEVAL_DESTINATION, destination: source });
      if (returned.status !== "COMPLETED") throw new Error("bin_return_incomplete");
    } catch (returnErr) {
      // The bin may still be physically at OUTPUT. Mirrors retrieval_commit_failed
      // below: never claim a status the database can't back up — leave the
      // movement RUNNING and the bin RESERVED for a human to reconcile.
      console.error(
        `[retrieval] INCONSISTENT movement=${movement.id} bin=${source} — verification failed and the ` +
          "bin could not be confirmed returned to its shelf. Reconciliation is required.",
        returnErr,
      );
      return fail(
        requestId,
        "photo_upload_failed",
        "Verification failed and the bin could not be confirmed returned to its shelf. Reconciliation is required.",
        { movementId: movement.id, partId: part.id, sourceBinCode: source },
      );
    }
    await releaseClaim(movement.id, sourceBin.id);
    return fail(
      requestId,
      "photo_required",
      "The camera verification failed, so the bin was returned to its shelf without being checked out.",
      { movementId: movement.id, partId: part.id, sourceBinCode: source },
    );
  }

  /* 10 — COMMIT TRANSACTION. The freshly verified count becomes both the
     checked-out quantity and the new Inventory baseline — camera-confirmed
     at the moment of removal rather than merely carried over from whatever
     the database last recorded. Still hidden from availability purely by
     Bin.status !== OCCUPIED, same as before. */
  try {
    await prisma.$transaction(async (tx) => {
      const stock = await tx.inventory.findUnique({
        where: { partId_binId: { partId: part.id, binId: sourceBin.id } },
      });
      if (!stock || stock.quantity !== sourceQuantityBefore) {
        throw new Error("checked-out inventory baseline changed during movement");
      }
      const checkedOut = await tx.bin.updateMany({
        where: { id: sourceBin.id, status: "RESERVED" },
        data: { status: "CHECKED_OUT" },
      });
      if (checkedOut.count !== 1) throw new Error("retrieval reservation was lost during movement");
      await tx.inventory.update({
        where: { id: stock.id },
        data: { quantity: verification.quantity },
      });
      await tx.movement.update({
        where: { id: movement.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          gantryOperationId: operation.operationId,
          quantity: verification.quantity,
          imageUrl: verification.imageUrl,
          verificationImageUrl: verification.imageUrl,
          verificationCapturedAt: verification.capturedAt,
        },
      });
    });
  } catch (err) {
    // The part HAS physically left the bin. Claiming failure outright would be
    // a lie and re-running the gantry would move a second item, so we do
    // neither: the movement stays RUNNING, every id is preserved, and a human
    // reconciles. This also covers stock that vanished mid-flight, which is a
    // conflict the gantry has already acted on.
    console.error(
      `[retrieval] INCONSISTENT movement=${movement.id} gantry=${operation.operationId} ` +
        `bin=${source} sku=${part.sku} — gantry completed but CHECKED_OUT state could not be saved.`,
      err,
    );
    return fail(
      requestId,
      "retrieval_commit_failed",
      "The gantry moved the bin to OUTPUT, but the warehouse could not save its CHECKED_OUT state. Reconciliation is required.",
      {
        movementId: movement.id,
        gantryOperationId: operation.operationId,
        partId: part.id,
        sourceBinCode: source,
      },
    );
  }

  logRetrieval(
    `movement=${movement.id} gantry=${operation.operationId} status=COMPLETED checkedOut=${verification.quantity}`,
  );

  return {
    ok: true,
    requestId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    sourceBinCode: source,
    destination: RETRIEVAL_DESTINATION,
    movementId: movement.id,
    gantryOperationId: operation.operationId,
    checkedOutQuantity: verification.quantity,
    inventoryQuantityRemoved: 0,
    remainingQuantityInBin: verification.quantity,
    binStatus: "CHECKED_OUT",
    status: "COMPLETED",
  };
}

/* ------------------------------------------------------------- internals */

/** A repeat of a request id: replay a finished retrieval, refuse a live one. */
async function replayOrReject(
  claimed: Movement,
  requestId: string,
): Promise<RetrievalResult> {
  if (claimed.status !== "COMPLETED") {
    return fail(
      requestId,
      "retrieval_in_progress",
      "This retrieval request is already running. Wait for it rather than submitting it again.",
      { movementId: claimed.id },
    );
  }

  const [part, bin] = await Promise.all([
    prisma.part.findUnique({ where: { id: claimed.partId } }),
    claimed.sourceBinId ? prisma.bin.findUnique({ where: { id: claimed.sourceBinId } }) : null,
  ]);
  if (!part) {
    return fail(requestId, "part_not_found", "The part for this completed retrieval is gone.", {
      movementId: claimed.id,
    });
  }

  const checkedOutQuantity = claimed.quantity;

  logRetrieval(`request=${requestId} movement=${claimed.id} status=DUPLICATE`);
  return {
    ok: true,
    requestId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    sourceBinCode: bin?.code ?? "",
    destination: RETRIEVAL_DESTINATION,
    movementId: claimed.id,
    gantryOperationId: claimed.gantryOperationId ?? "",
    checkedOutQuantity,
    inventoryQuantityRemoved: 0,
    remainingQuantityInBin: checkedOutQuantity,
    binStatus: "CHECKED_OUT",
    status: "COMPLETED",
    duplicate: true,
  } satisfies RetrievalSuccess;
}

function isUniqueViolation(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { code?: unknown }).code === "P2002"
  );
}

/**
 * Undoes a claim that never moved the bin: the movement becomes FAILED, the
 * source returns to OCCUPIED, and the request id is released.
 *
 * The idempotency key is cleared so the operator can retry the same request
 * after a failure, exactly as putaway does.
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
      data: { status: "OCCUPIED" },
    });
  });
}
