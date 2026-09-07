/**
 * Deterministic retrieval orchestration (Milestone 8).
 *
 * The mirror of PutawayService, and the same division of labour:
 *
 *     the agent REQUESTS a retrieval
 *     this service VALIDATES and EXECUTES it
 *     the simulator MOVES
 *     the database COMMITS only after the movement succeeded
 *
 * Nothing here trusts the caller. It does not trust that the agent already
 * called search_inventory and saw two in B2-01 — inventory is re-queried, and
 * the decrement itself is a conditional UPDATE, so stock cannot go negative
 * even if the world changed underneath the model's recollection.
 *
 * It is callable directly: a route, a demo script and the test suite all use
 * it with no LLM in the picture.
 *
 * THE INVARIANT THAT MATTERS MOST: inventory decreases only after the gantry
 * reports COMPLETED. The database must never say an item left the shelf
 * before it did.
 */
import { prisma } from "./db";
import { applyInventoryRemoval, getInventoryForPart } from "./inventory-service";
import { getBinByCode, getPartById, getPartBySku, updateMovementStatus } from "./repository";
import { isWarehouseError } from "./errors";
import {
  RETRIEVAL_DESTINATION,
  RETRIEVAL_QUANTITY,
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
 * POLICY: lowest bin code with stock.
 *
 * `getInventoryForPart` already orders locations by bin code ascending, so
 * this is the first stocked entry. Deterministic on purpose — neither the
 * model nor the graph ever picks a source bin by any other rule.
 */
export function chooseRetrievalSourceBinCode(
  stocked: readonly { binCode: string; quantity: number }[],
): string | null {
  return stocked[0]?.binCode ?? null;
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

  /* 1 — the request itself. Exactly one identifier: accepting both would need
     a precedence rule the caller cannot see, and a request naming two
     different parts is a mistake worth reporting. */
  const sku = typeof input?.sku === "string" ? input.sku.trim() : "";
  const partId = typeof input?.partId === "string" ? input.partId.trim() : "";
  if (Boolean(sku) === Boolean(partId)) {
    return fail(
      requestId,
      "invalid_request",
      "Provide exactly one of sku or partId to identify the part to retrieve.",
    );
  }

  /* 1b — quantity. Refused before the idempotency claim, so an unsupported
     request never consumes a request id or creates a movement. */
  const quantity = input?.quantity ?? RETRIEVAL_QUANTITY;
  if (quantity !== RETRIEVAL_QUANTITY) {
    return fail(
      requestId,
      "unsupported_quantity",
      `Retrieval moves one item per operation; ${quantity} were requested. ` +
        "Ask the operator to confirm a single item, then retry.",
    );
  }

  /* 2 — idempotency. One request id, one physical retrieval. */
  const claimed = await prisma.movement.findUnique({ where: { idempotencyKey } });
  if (claimed) {
    return replayOrReject(claimed, requestId);
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
  const stocked = summary.locations.filter((location) => location.quantity > 0);
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

  const sourceBin = await getBinByCode(source);
  if (!sourceBin) {
    return fail(requestId, "source_bin_not_found", `No bin has code "${source}".`);
  }

  /* 7 — gantry pre-check. Advisory: the authoritative guard is the
     controller's own synchronous claim, handled at step 9. */
  const gantry = getGantryController();
  const status = await gantry.getStatus();
  if (status.state !== "IDLE" || status.activeOperationId !== null) {
    return fail(
      requestId,
      "gantry_busy",
      `The gantry is ${status.state} and cannot start a retrieval right now.`,
      { partId: part.id, sourceBinCode: source },
    );
  }

  /* 8 — claim the request id and record intent. No bin reservation: retrieval
     takes stock out of a bin that is already OCCUPIED, and the gantry itself
     serialises physical access. */
  let movement: Movement;
  try {
    movement = await prisma.movement.create({
      data: {
        type: "RETRIEVAL",
        partId: part.id,
        quantity: RETRIEVAL_QUANTITY,
        status: "VALIDATED",
        sourceBinId: sourceBin.id,
        destinationLocation: RETRIEVAL_DESTINATION,
        idempotencyKey,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.movement.findUnique({ where: { idempotencyKey } });
      if (existing) return replayOrReject(existing, requestId);
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
    await releaseClaim(movement.id);
    if (busy) {
      return fail(
        requestId,
        "gantry_busy",
        "The gantry became busy before this retrieval could start.",
        { movementId: movement.id, partId: part.id, sourceBinCode: source },
      );
    }
    throw err;
  }

  if (operation.status !== "COMPLETED") {
    // The item is still assumed to be where it was: nothing left the bin.
    await releaseClaim(movement.id, operation.operationId);
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

  /* 10 — COMMIT TRANSACTION. Stock decreases, the bin frees itself if it just
     emptied, and the movement completes — together or not at all. The `gte`
     guard inside applyInventoryRemoval is what makes negative stock
     unrepresentable even under concurrency. */
  let remainingQuantityInBin: number;
  try {
    remainingQuantityInBin = await prisma.$transaction(async (tx) => {
      const record = await applyInventoryRemoval(tx, part, sourceBin, RETRIEVAL_QUANTITY);
      await tx.movement.update({
        where: { id: movement.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          gantryOperationId: operation.operationId,
        },
      });
      return record.quantity;
    });
  } catch (err) {
    // The part HAS physically left the bin. Claiming failure outright would be
    // a lie and re-running the gantry would move a second item, so we do
    // neither: the movement stays RUNNING, every id is preserved, and a human
    // reconciles. This also covers stock that vanished mid-flight, which is a
    // conflict the gantry has already acted on.
    const conflict =
      isWarehouseError(err) &&
      (err.code === "insufficient_inventory" || err.code === "inventory_not_found");
    console.error(
      `[retrieval] INCONSISTENT movement=${movement.id} gantry=${operation.operationId} ` +
        `bin=${source} sku=${part.sku} — gantry completed but the database commit failed` +
        (conflict ? " (stock changed underneath the operation)" : "") +
        `. The part has left the bin; inventory does NOT reflect it.`,
      err,
    );
    return fail(
      requestId,
      "retrieval_commit_failed",
      "The gantry completed the move but the warehouse database could not be updated. " +
        "The part has left the bin; inventory has not been updated. This needs manual reconciliation.",
      {
        movementId: movement.id,
        gantryOperationId: operation.operationId,
        partId: part.id,
        sourceBinCode: source,
      },
    );
  }

  logRetrieval(
    `movement=${movement.id} gantry=${operation.operationId} status=COMPLETED remaining=${remainingQuantityInBin}`,
  );

  return {
    ok: true,
    requestId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    sourceBinCode: source,
    destination: RETRIEVAL_DESTINATION,
    movementId: movement.id,
    gantryOperationId: operation.operationId,
    inventoryQuantityRemoved: RETRIEVAL_QUANTITY,
    remainingQuantityInBin,
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

  const remaining = bin
    ? ((await prisma.inventory.findUnique({
        where: { partId_binId: { partId: part.id, binId: bin.id } },
      })) ?? { quantity: 0 }).quantity
    : 0;

  logRetrieval(`request=${requestId} movement=${claimed.id} status=DUPLICATE`);
  return {
    ok: true,
    requestId,
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    sourceBinCode: bin?.code ?? "",
    destination: RETRIEVAL_DESTINATION,
    movementId: claimed.id,
    gantryOperationId: claimed.gantryOperationId ?? "",
    inventoryQuantityRemoved: 0,
    remainingQuantityInBin: remaining,
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
 * Undoes a claim that never removed stock: the movement becomes FAILED and the
 * request id is released.
 *
 * The idempotency key is cleared so the operator can retry the same request
 * after a failure, exactly as putaway does. No bin status is touched — a
 * failed retrieval never took anything out, so the bin is still as it was.
 */
async function releaseClaim(movementId: string, gantryOperationId?: string): Promise<void> {
  await prisma.movement.update({
    where: { id: movementId },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      idempotencyKey: null,
      ...(gantryOperationId ? { gantryOperationId } : {}),
    },
  });
}
