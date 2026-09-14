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
 * many items a client removes. Checkout verifies the current quantity, then
 * photographed return putaway separately reconciles the remainder after use.
 */
import { prisma } from "./db";
import { getInventoryByBin, getInventoryForPart } from "./inventory-service";
import { retrievalStockIssue } from "./retrieval-stock";
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
import { isOutOfSimulationScope, SimulationScopeError } from "./audit-capture-mode";
import { requirePutawayVerification } from "./putaway-verification";
import { getContextWorkflowSessionId, getContextBrowserScenario } from "@/lib/agents/request-context";
import { recordControlModuleCheckout } from "./control-module-scenario";

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
  const partId = typeof input?.partId === "string" ? input.partId.trim() : "";
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
  const stockIssue = retrievalStockIssue(summary, input.sourceBinCode);
  if (stockIssue) {
    return fail(requestId, stockIssue.reason, stockIssue.message, { partId: part.id, sourceBinCode: stockIssue.sourceBinCode });
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
      new SimulationScopeError(source).message,
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
          previousQuantity: sourceQuantityBefore,
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
    // A dispatched hardware command may have moved the bin despite a failed acknowledgement.
    await releaseClaim(movement.id, sourceBin.id, operation.operationId, operation.reconciliationRequired);
    logRetrieval(
      `movement=${movement.id} gantry=${operation.operationId} status=FAILED reason=${operation.error ?? "unknown"}`,
    );
    return fail(requestId, "gantry_failed", operation.reconciliationRequired
      ? "The retrieval's physical outcome is uncertain. The bin remains reserved; inspect the machine and reconcile before retrying."
      : "The gantry did not complete the retrieval.", {
      movementId: movement.id,
      gantryOperationId: operation.operationId,
      partId: part.id,
      sourceBinCode: source,
      error: operation.error ?? undefined,
    });
  }

  /* 10 — Record physical checkout before capture. No availability is restored
     if verification fails after the machine has moved the bin. */
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
      await tx.movement.update({
        where: { id: movement.id },
        data: {
          status: input.verifyContents === false ? "COMPLETED" : "AWAITING_VERIFICATION",
          completedAt: input.verifyContents === false ? new Date() : null,
          gantryOperationId: operation.operationId,
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

  let checkedOutQuantity = sourceQuantityBefore;
  if (input.verifyContents !== false) {
    try {
      const verified = await requirePutawayVerification(movement.id);
      if (!verified.inventoryUpdateApproved) throw new Error("Checkout count was not verified.");
      checkedOutQuantity = verified.quantity;
      await prisma.$transaction(async (tx) => {
        const updated = await tx.inventory.updateMany({
          where: { partId: part.id, binId: sourceBin.id, quantity: sourceQuantityBefore },
          // Keep a zero baseline while checked out so an empty bin still has
          // its catalog identity when it returns.
          data: { quantity: checkedOutQuantity },
        });
        if (updated.count !== 1) throw new Error("Checkout inventory changed during verification.");
        const completed = await tx.movement.updateMany({
          where: { id: movement.id, status: "AWAITING_VERIFICATION", sourceBin: { status: "CHECKED_OUT" } },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            destinationLocation: RETRIEVAL_DESTINATION,
            newQuantity: checkedOutQuantity,
            verificationImageUrl: verified.imageUrl,
            verificationCapturedAt: verified.capturedAt,
          },
        });
        if (completed.count !== 1) throw new Error("Checkout verification was superseded.");
      });
      if (getContextBrowserScenario()) recordControlModuleCheckout(getContextWorkflowSessionId(), source, checkedOutQuantity, verified.attempt ?? 0, sourceQuantityBefore);
    } catch (error) {
      // Movement has already happened. Never restore the shelf location or
      // clear the idempotency key, even after cancellation or a camera failure.
      await prisma.movement.updateMany({
        where: { id: movement.id, status: { in: ["AWAITING_VERIFICATION", "FAILED"] } },
        data: { status: "FAILED", completedAt: new Date() },
      });
      return fail(requestId, "retrieval_verification_failed",
        "The bin is at checkout, but its contents were not verified. Inventory was not changed. Remove unexpected objects and retry the check, or request putaway to verify it again.",
        { movementId: movement.id, gantryOperationId: operation.operationId, partId: part.id, sourceBinCode: source,
          error: error instanceof Error ? error.message : undefined });
    }
  }

  logRetrieval(
    `movement=${movement.id} gantry=${operation.operationId} status=COMPLETED checkedOut=${checkedOutQuantity}`,
  );

  return {
    ok: true,
    requestId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    sourceBinCode: source,
    destination: RETRIEVAL_DESTINATION,
    movementId: movement.id,
    gantryOperationId: operation.operationId,
    checkedOutQuantity,
    inventoryQuantityRemoved: 0,
    remainingQuantityInBin: checkedOutQuantity,
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

  const checkedOutQuantity = claimed.newQuantity ?? claimed.quantity;

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
 * Ends a failed claim. When no physical outcome is uncertain, the source
 * returns to OCCUPIED and the request id is released. Otherwise keep both.
 *
 * The idempotency key is cleared so the operator can retry the same request
 * after a failure, exactly as putaway does.
 */
async function releaseClaim(
  movementId: string,
  binId: string,
  gantryOperationId?: string,
  reconciliationRequired = false,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.movement.update({
      where: { id: movementId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        ...(reconciliationRequired ? {} : { idempotencyKey: null }),
        ...(gantryOperationId ? { gantryOperationId } : {}),
      },
    });
    if (reconciliationRequired) return;
    await tx.bin.updateMany({
      where: { id: binId, status: "RESERVED" },
      data: { status: "OCCUPIED" },
    });
  });
}
