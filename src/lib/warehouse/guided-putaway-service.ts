/**
 * Human-guided putaway for the scan-result dialog.
 *
 * Unlike executePutaway's single INTAKE -> slot movement, this workflow brings
 * the selected compatible bin to the operator, waits for an explicit placement
 * decision, then returns the bin. Inventory is committed only after that
 * return succeeds. The database and gantry therefore have separate, truthful
 * statuses throughout the workflow.
 */
import { prisma } from "./db";
import { matchScanToCatalog } from "./catalog-matcher";
import { resolveCatalogIdentity } from "./catalog-identity";
import { applyInventoryAddition } from "./inventory-service";
import {
  evaluatePutawayDestination,
  type PutawayDestinationEvaluation,
} from "./putaway-destination";
import { collectScanResultIssues } from "./scan-result";
import { getBinByCode } from "./repository";
import type { BinStatus } from "./types";
import { getGantryController } from "@/lib/gantry/factory";
import { isGantryError } from "@/lib/gantry/errors";
import type { GantryOperation, WarehouseBinCode } from "@/lib/gantry/types";
import type { Bin, Movement, Part } from "@/generated/prisma/client";
import type {
  GuidedPutawayContext,
  GuidedPlacementDecision,
  GuidedPutawayRequest,
  GuidedPutawayResult,
  GuidedPutawayStatusView,
} from "./guided-putaway-types";
import { uploadPutawayPhoto } from "./storage";
import { requirePutawayVerification } from "./putaway-verification";
import { isOutOfSimulationScope, SimulationScopeError } from "./audit-capture-mode";

const QUANTITY = 1;

function destinationFailure(
  binCode: string,
  capacity: number,
  evaluation: PutawayDestinationEvaluation,
  scanId: string,
): GuidedPutawayResult {
  switch (evaluation.reason) {
    case "FULL":
      return failure(
        "bin_capacity_exceeded",
        `Bin ${binCode} is full (${evaluation.currentQuantity}/${capacity}). Choose another compatible bin.`,
        { scanId },
      );
    case "DIFFERENT_PART":
      return failure(
        "inventory_conflict",
        `Bin ${binCode} stores a different item. Choose the identified item's existing bin or an empty bin.`,
        { scanId },
      );
    case "RESERVED":
      return failure(
        "bin_unavailable",
        `Bin ${binCode} is reserved by another operation.`,
        {
          scanId,
        },
      );
    case "CHECKED_OUT":
      return failure(
        "bin_unavailable",
        `Bin ${binCode} is currently checked out.`,
        { scanId },
      );
    case "DISABLED":
      return failure("bin_unavailable", `Bin ${binCode} is disabled.`, {
        scanId,
      });
    default:
      return failure(
        "bin_unavailable",
        `Bin ${binCode} has inconsistent status and inventory data and needs review.`,
        { scanId },
      );
  }
}

function failure(
  reason: string,
  message: string,
  extra: Partial<Extract<GuidedPutawayResult, { ok: false }>> = {},
): GuidedPutawayResult {
  return {
    ok: false,
    reason,
    message,
    databaseStatus: "CHECKING",
    gantryStatus: "IDLE",
    ...extra,
  };
}

function context(
  movement: Movement,
  part: Part,
  bin: Bin,
): GuidedPutawayContext {
  return {
    movementId: movement.id,
    scanId: movement.scanId ?? "",
    part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
    destinationBinCode: bin.code,
  };
}

function uniqueViolation(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "P2002"
  );
}

async function movementWithContext(movementId: string) {
  return prisma.movement.findUnique({
    where: { id: movementId },
    include: { part: true, destinationBin: true },
  });
}

/** Latest durable guided-putaway state for one physical scan. Read-only. */
export async function getGuidedPutawayStatusForScan(
  scanId: string,
): Promise<GuidedPutawayStatusView | null> {
  const movement = await prisma.movement.findFirst({
    where: { scanId, type: "PUTAWAY" },
    include: { part: true, destinationBin: true },
    orderBy: { createdAt: "desc" },
  });
  if (!movement?.destinationBin) return null;

  const statuses: Record<
    string,
    Pick<GuidedPutawayStatusView, "databaseStatus" | "gantryStatus">
  > = {
    VALIDATED: { databaseStatus: "RESERVED", gantryStatus: "IDLE" },
    PRESENTING: { databaseStatus: "RESERVED", gantryStatus: "FETCHING_BIN" },
    AWAITING_PLACEMENT: {
      databaseStatus: "WAITING_TO_SAVE",
      gantryStatus: "WAITING_FOR_PLACEMENT",
    },
    RETURNING: {
      databaseStatus: "WAITING_TO_SAVE",
      gantryStatus: "RETURNING_BIN",
    },
    READY_TO_COMMIT: { databaseStatus: "SAVING", gantryStatus: "COMPLETED" },
    READY_TO_CANCEL: { databaseStatus: "SAVING", gantryStatus: "COMPLETED" },
    COMPLETED: { databaseStatus: "SAVED", gantryStatus: "COMPLETED" },
    CANCELLED: { databaseStatus: "RELEASED", gantryStatus: "COMPLETED" },
    FAILED: {
      databaseStatus: "RECONCILIATION_REQUIRED",
      gantryStatus: "FAILED",
    },
  };
  const status = statuses[movement.status] ?? {
    databaseStatus: "CHECKING" as const,
    gantryStatus: "IDLE" as const,
  };

  return {
    ...context(movement, movement.part, movement.destinationBin),
    movementStatus: movement.status,
    ...status,
    gantryOperationId: movement.gantryOperationId,
    completedAt: movement.completedAt?.getTime() ?? null,
  };
}

/* ------------------------------------------------- abandoned reservations */

/**
 * How long a guided putaway may sit with no forward progress before it is
 * treated as abandoned.
 *
 * A hard refresh, a closed laptop or a crash between `prepareGuidedPutaway`
 * and `commitGuidedPutaway` leaves a bin RESERVED with nothing driving it, and
 * every forward step is client-initiated — so without this the slot is gone
 * until someone edits the database by hand. Same reasoning as
 * ActionApproval's APPROVAL_TTL_MS, and swept lazily on the next putaway
 * attempt rather than by a scheduler, exactly like catalog-resolution-service's
 * `withExpiry`: this MVP has no background jobs, and a reservation nobody ever
 * comes back to costs nothing until someone needs that slot.
 *
 * Generous on purpose. The window covers a person physically walking to the
 * intake station and back, and being slow is not a fault.
 */
export const GUIDED_PUTAWAY_TTL_MS = 15 * 60 * 1000;

/**
 * Reserved, but nothing has physically moved: the gantry was never asked to
 * fetch the bin. The slot is still sitting on its shelf, empty, so releasing it
 * is a statement of fact.
 */
const ABANDONED_BEFORE_ANY_MOTION = ["VALIDATED"] as const;

/**
 * The bin has left its shelf. Where it ended up, and whether an operator put
 * something in it before walking away, is not knowable from here — so the
 * movement is closed honestly as FAILED and the slot stays RESERVED for a human
 * to reconcile. Releasing it to AVAILABLE would be the machine inventing a
 * physical fact, which is exactly what `presentGuidedPutawayBin` already
 * refuses to do when the gantry fails mid-transfer.
 */
const ABANDONED_WITH_BIN_OFF_SHELF = [
  "PRESENTING",
  "AWAITING_PLACEMENT",
  "RETURNING",
  "READY_TO_COMMIT",
  "READY_TO_CANCEL",
] as const;

export interface GuidedPutawaySweepResult {
  /** Bin codes restored to their inventory-derived status because nothing physically happened. */
  released: string[];
  /** Bin codes left RESERVED because the machine cannot know what is inside them. */
  reconciliationRequired: string[];
}

/**
 * Closes guided putaways that stopped making progress and frees the slots it
 * can honestly free. Idempotent, and safe to run beside a live workflow: every
 * write is conditional on the status the sweep actually observed, so a putaway
 * that resumes a millisecond later loses the race rather than being corrupted.
 */
export async function sweepAbandonedGuidedPutaways(
  now: Date = new Date(),
): Promise<GuidedPutawaySweepResult> {
  const cutoff = new Date(now.getTime() - GUIDED_PUTAWAY_TTL_MS);
  const stale = await prisma.movement.findMany({
    where: {
      type: "PUTAWAY",
      status: {
        in: [...ABANDONED_BEFORE_ANY_MOTION, ...ABANDONED_WITH_BIN_OFF_SHELF],
      },
      createdAt: { lt: cutoff },
    },
    include: { destinationBin: true },
  });

  const result: GuidedPutawaySweepResult = {
    released: [],
    reconciliationRequired: [],
  };

  for (const movement of stale) {
    const releasable = (
      ABANDONED_BEFORE_ANY_MOTION as readonly string[]
    ).includes(movement.status);
    try {
      const swept = await prisma.$transaction(async (tx) => {
        // The audit trail is never dropped: the row is closed, not deleted, and
        // idempotencyKey is cleared so the operator may retry the same scan.
        const claimed = await tx.movement.updateMany({
          where: { id: movement.id, status: movement.status },
          data: {
            status: releasable ? "CANCELLED" : "FAILED",
            completedAt: now,
            idempotencyKey: null,
          },
        });
        if (claimed.count !== 1) return false;
        if (!releasable || !movement.destinationBin) return true;

        // Nothing moved, so the reservation can be released. Restore the
        // inventory-derived status: an empty destination is AVAILABLE, while
        // a same-item destination remains truthfully OCCUPIED.
        const held = await tx.inventory.count({
          where: { binId: movement.destinationBin.id, quantity: { gt: 0 } },
        });
        await tx.bin.updateMany({
          where: { id: movement.destinationBin.id, status: "RESERVED" },
          data: { status: held > 0 ? "OCCUPIED" : "AVAILABLE" },
        });
        return true;
      });
      if (!swept) continue;
    } catch (error) {
      // One stuck row must never block the putaway that triggered the sweep.
      console.error(
        "[guided-putaway] abandoned reservation sweep failed",
        movement.id,
        error,
      );
      continue;
    }

    const code = movement.destinationBin?.code;
    if (!code) continue;
    if (releasable) result.released.push(code);
    else result.reconciliationRequired.push(code);
  }

  if (result.released.length > 0 || result.reconciliationRequired.length > 0) {
    console.warn(
      `[guided-putaway] swept abandoned reservations — released ${
        result.released.join(", ") || "none"
      }; left reserved for reconciliation ${
        result.reconciliationRequired.join(", ") || "none"
      }`,
    );
  }
  return result;
}

/** Validate identity and atomically reserve the operator-selected slot. */
export async function prepareGuidedPutaway(
  input: GuidedPutawayRequest,
): Promise<GuidedPutawayResult> {
  const scanResult = input?.scanResult;
  const scanId =
    typeof scanResult?.scanId === "string" ? scanResult.scanId : "";
  if (typeof input?.destinationBinCode === "string" && isOutOfSimulationScope(input.destinationBinCode)) {
    return failure("simulation_scope_violation", new SimulationScopeError(input.destinationBinCode).message, { scanId });
  }
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    return failure(
      "invalid_scan",
      `The scan is not valid: ${issues.join("; ")}`,
      { scanId },
    );
  }

  // Before claiming a slot, hand back any slot a previous session abandoned.
  // Done here rather than in the dashboard read path so the overview endpoint
  // stays strictly read-only, and here rather than on dialog unmount because a
  // hard refresh or a crash never gets to run an unmount handler.
  await sweepAbandonedGuidedPutaways();

  const existing = await prisma.movement.findUnique({
    where: { idempotencyKey: scanId },
  });
  if (existing) {
    return failure(
      existing.status === "COMPLETED"
        ? "putaway_already_completed"
        : "putaway_in_progress",
      existing.status === "COMPLETED"
        ? "This scan has already been stored."
        : "This scan already has a putaway in progress.",
      { movementId: existing.id, scanId },
    );
  }

  const match = await matchScanToCatalog(scanResult);
  const resolved = await resolveCatalogIdentity({
    scanId,
    match,
    catalogResolutionId: input.catalogResolutionId,
  });
  if (!resolved.ok) {
    return failure(resolved.reason, resolved.message, { scanId });
  }

  const [part, bin] = await Promise.all([
    prisma.part.findUnique({ where: { id: resolved.identity.partId } }),
    getBinByCode(input.destinationBinCode),
  ]);
  if (!part)
    return failure(
      "part_not_found",
      "The identified part is no longer in the catalog.",
      { scanId },
    );
  if (!bin)
    return failure(
      "bin_not_found",
      `No bin has code "${input.destinationBinCode}".`,
      { scanId },
    );
  const contents = await prisma.inventory.findMany({
    where: { binId: bin.id, quantity: { gt: 0 } },
    select: { partId: true, quantity: true },
  });
  const destination = evaluatePutawayDestination(
    { ...bin, status: bin.status as BinStatus, contents },
    part.id,
    QUANTITY,
  );
  if (!destination.eligible) {
    return destinationFailure(bin.code, bin.capacity, destination, scanId);
  }
  let movement: Movement;
  try {
    movement = await prisma.$transaction(async (tx) => {
      const reserved = await tx.bin.updateMany({
        where: { id: bin.id, status: bin.status },
        data: { status: "RESERVED" },
      });
      if (reserved.count !== 1) throw new Error("bin_reservation_conflict");
      const freshContents = await tx.inventory.findMany({
        where: { binId: bin.id, quantity: { gt: 0 } },
        select: { partId: true, quantity: true },
      });
      const freshDestination = evaluatePutawayDestination(
        {
          ...bin,
          status: bin.status as BinStatus,
          contents: freshContents,
        },
        part.id,
        QUANTITY,
      );
      if (!freshDestination.eligible) {
        throw new Error(`destination_${freshDestination.reason}`);
      }
      return tx.movement.create({
        data: {
          type: "PUTAWAY",
          partId: part.id,
          quantity: QUANTITY,
          status: "VALIDATED",
          destinationBinId: bin.id,
          sourceLocation: "INTAKE",
          scanId,
          idempotencyKey: scanId,
        },
      });
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      return failure(
        "putaway_in_progress",
        "This scan or slot was claimed concurrently.",
        { scanId },
      );
    }
    if (
      error instanceof Error &&
      error.message === "bin_reservation_conflict"
    ) {
      return failure(
        "bin_reservation_conflict",
        `Bin ${bin.code} was just reserved by another operation.`,
        { scanId },
      );
    }
    if (error instanceof Error && error.message.startsWith("destination_")) {
      const reason = error.message.slice(
        "destination_".length,
      ) as PutawayDestinationEvaluation["reason"];
      const freshContents = await prisma.inventory.findMany({
        where: { binId: bin.id, quantity: { gt: 0 } },
        select: { partId: true, quantity: true },
      });
      const freshEvaluation = evaluatePutawayDestination(
        {
          ...bin,
          status: bin.status as BinStatus,
          contents: freshContents,
        },
        part.id,
        QUANTITY,
      );
      return destinationFailure(
        bin.code,
        bin.capacity,
        freshEvaluation.reason === "COMPATIBLE"
          ? { ...freshEvaluation, eligible: false, reason }
          : freshEvaluation,
        scanId,
      );
    }
    throw error;
  }

  // Best-effort: a photo is evidence for later, never something the physical
  // reservation should be blocked by. Failure is logged and the workflow
  // continues exactly as if no photo had been supplied.
  if (input.imageDataUrl) {
    try {
      const imageUrl = await uploadPutawayPhoto(scanId, input.imageDataUrl);
      await prisma.movement.update({
        where: { id: movement.id },
        data: { imageUrl },
      });
    } catch (error) {
      console.error(
        "[guided-putaway] photo upload failed, continuing without it:",
        error,
      );
    }
  }

  return {
    ok: true,
    stage: "RESERVED",
    ...context(movement, part, bin),
    identity: resolved.identity,
    databaseStatus: "RESERVED",
    gantryStatus: "IDLE",
  };
}

/** Move the reserved compatible bin from its shelf to the operator. */
export async function presentGuidedPutawayBin(
  movementId: string,
): Promise<GuidedPutawayResult> {
  const loaded = await movementWithContext(movementId);
  if (!loaded || !loaded.destinationBin || loaded.type !== "PUTAWAY") {
    return failure("movement_not_found", "That guided putaway does not exist.");
  }
  const info = context(loaded, loaded.part, loaded.destinationBin);
  if (isOutOfSimulationScope(loaded.destinationBin.code)) {
    return failure("simulation_scope_violation", new SimulationScopeError(loaded.destinationBin.code).message, info);
  }
  const claimed = await prisma.movement.updateMany({
    where: { id: loaded.id, status: "VALIDATED" },
    data: { status: "PRESENTING" },
  });
  if (claimed.count !== 1) {
    return failure(
      "invalid_putaway_stage",
      `This putaway is already ${loaded.status}.`,
      {
        ...info,
        databaseStatus:
          loaded.status === "AWAITING_PLACEMENT"
            ? "WAITING_TO_SAVE"
            : "RESERVED",
      },
    );
  }

  let operation: GantryOperation;
  try {
    operation = await getGantryController().presentBin({
      source: loaded.destinationBin.code as WarehouseBinCode,
      destination: "INTAKE",
    });
  } catch (error) {
    if (isGantryError(error) && error.code === "gantry_busy") {
      await prisma.movement.updateMany({
        where: { id: loaded.id, status: "PRESENTING" },
        data: { status: "VALIDATED" },
      });
      return failure(
        "gantry_busy",
        "The gantry became busy before it could fetch the bin.",
        {
          ...info,
          databaseStatus: "RESERVED",
          gantryStatus: "FAILED",
        },
      );
    }
    await prisma.movement.updateMany({
      where: { id: loaded.id, status: "PRESENTING" },
      data: { status: "FAILED", completedAt: new Date() },
    });
    return failure("gantry_failed", "The bin presentation could not be started. Check the controller and reconcile the reserved bin.", {
      ...info, databaseStatus: "RECONCILIATION_REQUIRED", gantryStatus: "FAILED",
    });
  }

  if (operation.status !== "COMPLETED") {
    await prisma.movement.update({
      where: { id: loaded.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        gantryOperationId: operation.operationId,
      },
    });
    return failure(
      "gantry_failed",
      "The bin could not be presented. Its slot remains reserved for reconciliation.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "FAILED",
        gantryOperationId: operation.operationId,
      },
    );
  }

  try {
    await prisma.movement.update({
      where: { id: loaded.id },
      data: {
        status: "AWAITING_PLACEMENT",
        gantryOperationId: operation.operationId,
      },
    });
  } catch (error) {
    console.error(
      "[guided-putaway] bin presented but status persistence failed",
      error,
    );
    return failure(
      "presentation_commit_failed",
      "The bin reached INTAKE, but its database status could not be saved. Reconciliation is required.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "COMPLETED",
        gantryOperationId: operation.operationId,
      },
    );
  }

  return {
    ok: true,
    stage: "AWAITING_PLACEMENT",
    ...info,
    databaseStatus: "WAITING_TO_SAVE",
    gantryStatus: "WAITING_FOR_PLACEMENT",
    gantryOperationId: operation.operationId,
  };
}

/** Return the bin and durably bind the operator's placement decision. */
export async function returnGuidedPutawayBin(
  movementId: string,
  decision: GuidedPlacementDecision,
): Promise<GuidedPutawayResult> {
  const loaded = await movementWithContext(movementId);
  if (!loaded || !loaded.destinationBin || loaded.type !== "PUTAWAY") {
    return failure("movement_not_found", "That guided putaway does not exist.");
  }
  const info = context(loaded, loaded.part, loaded.destinationBin);
  if (isOutOfSimulationScope(loaded.destinationBin.code)) {
    return failure("simulation_scope_violation", new SimulationScopeError(loaded.destinationBin.code).message, info);
  }
  const placed = decision.placed;

  let verification:
    | {
        verificationImageUrl: string;
        verificationCapturedAt: Date;
        inventoryUpdateApproved: boolean;
      }
    | undefined;
  if (placed) {
    try {
      const verified = await requirePutawayVerification(loaded.id, true);
      verification = {
        verificationImageUrl: verified.imageUrl,
        verificationCapturedAt: verified.capturedAt,
        inventoryUpdateApproved: verified.inventoryUpdateApproved,
      };
    } catch (error) {
      console.error("[guided-putaway] Raspberry Pi verification failed", error);
      return failure(
        "placement_photo_required",
        "The Raspberry Pi verification did not complete. The bin is still at intake—request a fresh photo before returning it.",
        {
          ...info,
          databaseStatus: "WAITING_TO_SAVE",
          gantryStatus: "WAITING_FOR_PLACEMENT",
        },
      );
    }
  }

  const verificationEvidence = verification
    ? {
        verificationImageUrl: verification.verificationImageUrl,
        verificationCapturedAt: verification.verificationCapturedAt,
      }
    : undefined;
  const inventoryUpdateApproved =
    placed && verification?.inventoryUpdateApproved === true;
  const claimed = await prisma.movement.updateMany({
    where: { id: loaded.id, status: "AWAITING_PLACEMENT" },
    data: { status: "RETURNING", ...verificationEvidence },
  });
  if (claimed.count !== 1) {
    return failure(
      "invalid_putaway_stage",
      `This putaway is already ${loaded.status}.`,
      {
        ...info,
        databaseStatus: loaded.status === "COMPLETED" ? "SAVED" : "RESERVED",
      },
    );
  }

  let operation: GantryOperation;
  try {
    operation = await getGantryController().returnBin({
      source: "INTAKE",
      destination: loaded.destinationBin.code as WarehouseBinCode,
    });
  } catch (error) {
    if (isGantryError(error) && error.code === "gantry_busy") {
      await prisma.movement.updateMany({
        where: { id: loaded.id, status: "RETURNING" },
        data: { status: "AWAITING_PLACEMENT" },
      });
      return failure(
        "gantry_busy",
        "The gantry became busy before the bin could return. The placement decision is still waiting.",
        {
          ...info,
          databaseStatus: "WAITING_TO_SAVE",
          gantryStatus: "FAILED",
        },
      );
    }
    await prisma.movement.updateMany({
      where: { id: loaded.id, status: "RETURNING" },
      data: { status: "FAILED", completedAt: new Date() },
    });
    return failure(
      "gantry_failed",
      "The bin return could not be started. Inventory was not saved and reconciliation is required.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "FAILED",
      },
    );
  }
  if (operation.status !== "COMPLETED") {
    await prisma.movement.update({
      where: { id: loaded.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        gantryOperationId: operation.operationId,
      },
    });
    return failure(
      "gantry_failed",
      "The bin did not return to its slot. Inventory was not saved and reconciliation is required.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "FAILED",
        gantryOperationId: operation.operationId,
      },
    );
  }

  try {
    await prisma.movement.update({
      where: { id: loaded.id },
      data: {
        status: inventoryUpdateApproved ? "READY_TO_COMMIT" : "READY_TO_CANCEL",
        gantryOperationId: operation.operationId,
      },
    });
  } catch (error) {
    console.error(
      "[guided-putaway] bin returned but decision persistence failed",
      error,
    );
    return failure(
      "putaway_commit_failed",
      "The bin returned successfully, but Supabase could not record that it is ready to save. Reconciliation is required.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "COMPLETED",
        gantryOperationId: operation.operationId,
      },
    );
  }

  return {
    ok: true,
    stage: "BIN_RETURNED",
    ...info,
    databaseStatus: "SAVING",
    gantryStatus: "COMPLETED",
    gantryOperationId: operation.operationId,
  };
}

/**
 * Final database-only step. The gantry has already returned the bin; this is
 * deliberately a separate call so the UI can show movement completion and
 * Supabase persistence as two independent facts.
 */
export async function commitGuidedPutaway(
  movementId: string,
): Promise<GuidedPutawayResult> {
  const loaded = await movementWithContext(movementId);
  if (!loaded || !loaded.destinationBin || loaded.type !== "PUTAWAY") {
    return failure("movement_not_found", "That guided putaway does not exist.");
  }
  const info = context(loaded, loaded.part, loaded.destinationBin);
  const placed = loaded.status === "READY_TO_COMMIT";
  const cancelled = loaded.status === "READY_TO_CANCEL";
  if (!placed && !cancelled) {
    return failure(
      "invalid_putaway_stage",
      `This putaway is ${loaded.status}, not ready to save.`,
      {
        ...info,
        databaseStatus:
          loaded.status === "COMPLETED" ? "SAVED" : "RECONCILIATION_REQUIRED",
        gantryStatus: "COMPLETED",
      },
    );
  }

  try {
    if (placed) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.movement.updateMany({
          where: { id: loaded.id, status: "READY_TO_COMMIT" },
          data: { status: "RETURNING" },
        });
        if (claimed.count !== 1) throw new Error("commit_already_claimed");
        // The bin has been "RESERVED" (not "AVAILABLE") since prepareGuidedPutaway
        // claimed it — applyInventoryAddition's own conditional lock matches
        // against whatever status is passed in, so it must be the bin's real
        // current status, not a hardcoded guess. Passing the wrong status here
        // made the lock match zero rows and fail every real commit.
        await applyInventoryAddition(tx, loaded.part, loaded.destinationBin!, QUANTITY);
        await tx.bin.update({
          where: { id: loaded.destinationBin!.id },
          data: { status: "OCCUPIED" },
        });
        await tx.movement.update({
          where: { id: loaded.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.movement.updateMany({
          where: { id: loaded.id, status: "READY_TO_CANCEL" },
          data: { status: "RETURNING" },
        });
        if (claimed.count !== 1) throw new Error("commit_already_claimed");
        const held = await tx.inventory.count({
          where: { binId: loaded.destinationBin!.id, quantity: { gt: 0 } },
        });
        await tx.bin.update({
          where: { id: loaded.destinationBin!.id },
          data: { status: held > 0 ? "OCCUPIED" : "AVAILABLE" },
        });
        await tx.movement.update({
          where: { id: loaded.id },
          data: {
            status: "CANCELLED",
            completedAt: new Date(),
            idempotencyKey: null,
          },
        });
      });
    }
  } catch (error) {
    console.error("[guided-putaway] final Supabase commit failed", error);
    return failure(
      "putaway_commit_failed",
      "The gantry completed, but Supabase could not save the final warehouse state. Reconciliation is required.",
      {
        ...info,
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "COMPLETED",
        gantryOperationId: loaded.gantryOperationId ?? undefined,
      },
    );
  }

  return {
    ok: true,
    stage: placed ? "COMPLETED" : "CANCELLED",
    ...info,
    databaseStatus: placed ? "SAVED" : "RELEASED",
    gantryStatus: "COMPLETED",
    gantryOperationId: loaded.gantryOperationId ?? undefined,
    inventoryQuantityAdded: placed ? 1 : 0,
  };
}
