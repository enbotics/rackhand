/**
 * Manual escape hatch for testing (Prod or Simulation): a crashed or
 * interrupted operation can leave a bin parked in a non-terminal status
 * (RESERVED, CHECKED_OUT, AUDITING) with no way back to a retestable state
 * short of hand-editing the database. This is an operator-only admin action,
 * never an agent tool — the model must never be able to reach it.
 *
 * QUANTITIES ARE NEVER TOUCHED. Every write path that changes Inventory.quantity
 * commits it in the SAME $transaction as the bin's terminal status flip (see
 * putaway-service.ts and retrieval-service.ts). A bin stuck in one of these
 * statuses is, by definition, one where that transaction never ran — its
 * inventory is exactly what it was before the stuck attempt started. Resetting
 * only ever touches Bin.status plus the dangling Movement/capture/audit rows
 * that would otherwise keep pointing at a dead operation.
 *
 * THE GANTRY ALSO NEEDS RESETTING, SEPARATELY FROM THE DATABASE. Its
 * simulated position/last-operation memory is process-local (see
 * gantry/factory.ts) and is never written by any of the transactions above —
 * so a bin whose Bin.status this function just fixed can still be rendered
 * "IN TRANSIT"/"BIN AT STATION" by the rack view, which derives that purely
 * from the gantry's own leftover state. Dropping the cached controller here
 * (only when something was actually stale) makes the next status poll build
 * a fresh one at HOME/IDLE with no memory of the dead operation.
 */
import { prisma } from "./db";
import { resetGantryController } from "@/lib/gantry/factory";
import type { BinStatus } from "./types";

const STALE_BIN_STATUSES = ["RESERVED", "CHECKED_OUT", "AUDITING"] as const;

/** Movement statuses that mean an operation is still (or was still) in flight. */
const NON_TERMINAL_MOVEMENT_STATUSES = [
  "PENDING",
  "VALIDATED",
  "RUNNING",
  "PRESENTING",
  "AWAITING_PLACEMENT",
  "RETURNING",
  "READY_TO_COMMIT",
  "READY_TO_CANCEL",
];

/** PutawayCaptureRequest statuses a human never got to act on before the crash. */
const NON_TERMINAL_PUTAWAY_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  "CAPTURING",
  "READY",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
];

/** BinAudit statuses that mean the audit machine was still working the bin. */
const NON_TERMINAL_BIN_AUDIT_STATUSES = ["PENDING", "RUNNING"];

/** AuditCaptureRequest statuses a human never got to act on before the crash. */
const NON_TERMINAL_AUDIT_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  "CAPTURING",
  "PENDING_ACK",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
];

export interface ForceResetSummary {
  binsReset: Array<{ code: string; from: BinStatus; to: BinStatus }>;
  movementsFailed: number;
  putawayCapturesFailed: number;
  binAuditsFailed: number;
  auditCapturesFailed: number;
}

/**
 * Reverts every bin stuck in RESERVED / CHECKED_OUT / AUDITING back to the
 * status it must have held before the stuck attempt began, and fails any
 * dangling Movement/capture/audit row still pointing at that bin so the
 * dashboard and chat popups stop waiting on an operation that is never
 * coming back.
 *
 * RESERVED reverts to OCCUPIED if the bin still holds inventory (it was
 * claimed off a stocked shelf bin, e.g. a retrieval) or AVAILABLE if it holds
 * none (it was claimed as an empty putaway destination). CHECKED_OUT and
 * AUDITING both revert to OCCUPIED — the bin's last-recorded inventory is
 * exactly what it was before the checkout/audit attempt.
 */
export async function forceResetStaleBins(): Promise<ForceResetSummary> {
  const staleBins = await prisma.bin.findMany({
    where: { status: { in: [...STALE_BIN_STATUSES] } },
    include: { inventory: { where: { quantity: { gt: 0 } }, select: { id: true } } },
  });

  const summary: ForceResetSummary = {
    binsReset: [],
    movementsFailed: 0,
    putawayCapturesFailed: 0,
    binAuditsFailed: 0,
    auditCapturesFailed: 0,
  };
  const now = new Date();

  for (const bin of staleBins) {
    const from = bin.status as BinStatus;
    const to: BinStatus =
      from === "RESERVED" && bin.inventory.length === 0 ? "AVAILABLE" : "OCCUPIED";

    await prisma.$transaction(async (tx) => {
      // Conditional on the status we read: if something else already moved
      // this bin on, leave it alone rather than clobbering fresh state.
      const updated = await tx.bin.updateMany({
        where: { id: bin.id, status: from },
        data: { status: to },
      });
      if (updated.count !== 1) return;

      const movements = await tx.movement.findMany({
        where: {
          status: { in: NON_TERMINAL_MOVEMENT_STATUSES },
          OR: [{ sourceBinId: bin.id }, { destinationBinId: bin.id }],
        },
        select: { id: true },
      });
      if (movements.length > 0) {
        const movementIds = movements.map((m) => m.id);
        await tx.movement.updateMany({
          where: { id: { in: movementIds } },
          data: { status: "FAILED", completedAt: now },
        });
        summary.movementsFailed += movementIds.length;

        const putawayCaptures = await tx.putawayCaptureRequest.updateMany({
          where: {
            movementId: { in: movementIds },
            status: { in: NON_TERMINAL_PUTAWAY_CAPTURE_STATUSES },
          },
          data: { status: "FAILED", expiresAt: null },
        });
        summary.putawayCapturesFailed += putawayCaptures.count;
      }

      if (from === "AUDITING") {
        const audits = await tx.binAudit.findMany({
          where: { binId: bin.id, status: { in: NON_TERMINAL_BIN_AUDIT_STATUSES } },
          select: { id: true },
        });
        if (audits.length > 0) {
          const auditIds = audits.map((a) => a.id);
          await tx.binAudit.updateMany({
            where: { id: { in: auditIds } },
            data: {
              status: "FAILED",
              completedAt: now,
              errorCode: "force_reset",
              errorMessage: "Reset by an operator; the audit machine never finished this bin.",
            },
          });
          summary.binAuditsFailed += auditIds.length;

          const auditCaptures = await tx.auditCaptureRequest.updateMany({
            where: {
              binAuditId: { in: auditIds },
              status: { in: NON_TERMINAL_AUDIT_CAPTURE_STATUSES },
            },
            data: { status: "FAILED", expiresAt: null },
          });
          summary.auditCapturesFailed += auditCaptures.count;
        }
      }
    });

    summary.binsReset.push({ code: bin.code, from, to });
  }

  // The gantry's own memory of "the last trip involved this bin" outlives the
  // database fix above — drop it too, but only when something was actually
  // stale, so an unrelated live operation elsewhere is never interrupted by a
  // reset that found nothing wrong.
  if (summary.binsReset.length > 0) resetGantryController();

  return summary;
}
