import { prisma } from "./db";

const PRE_MOTION_STATUSES = ["VALIDATED", "AWAITING_PLACEMENT"];
const ACTIVE_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  "CAPTURING",
  "READY",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
  "ANALYSIS_FAILED",
  "ACCEPTED",
];
const ACTIVE_CAMERA_JOB_STATUSES = ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"];
const FAILED_CAPTURE_RECOVERY_GRACE_MS = 30_000;

/**
 * Every camera/review transition refreshes updatedAt, so this is an inactivity
 * timeout rather than a fixed wall-clock limit for the entire operation.
 */
export const DEFAULT_PUTAWAY_INACTIVITY_TIMEOUT_MS = 4 * 60_000;

function inactivityTimeoutMs(): number {
  const configured = Number(process.env.PUTAWAY_INACTIVITY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1_000
    ? configured
    : DEFAULT_PUTAWAY_INACTIVITY_TIMEOUT_MS;
}

class PutawayRecoveryRace extends Error {}

interface RecoverableMovement {
  type: string;
  id: string;
  destinationBinId: string | null;
  sourceBinId: string | null;
  sourceLocation: string | null;
  previousQuantity: number | null;
}

function destinationStatusBeforeReservation(movement: RecoverableMovement): string {
  if (movement.sourceLocation === "OUTPUT") {
    return movement.sourceBinId && movement.sourceBinId !== movement.destinationBinId
      ? "AVAILABLE"
      : "CHECKED_OUT";
  }
  return (movement.previousQuantity ?? 0) > 0 ? "OCCUPIED" : "AVAILABLE";
}

async function releasePreMotionMovement(
  movement: RecoverableMovement,
  capture: { id: string; status: string; updatedAt: Date } | null,
  cutoff: Date,
  now: Date,
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (capture) {
        const claimedCapture = await tx.putawayCaptureRequest.updateMany({
          where: {
            id: capture.id,
            status: capture.status,
            updatedAt: { lte: cutoff },
          },
          data: {
            status: "FAILED",
            expiresAt: null,
            notes: "Putaway verification was released after operator inactivity.",
          },
        });
        if (claimedCapture.count !== 1) throw new PutawayRecoveryRace();
      }

      // This claim is the physical-safety boundary. A movement that reached
      // RUNNING may have moved a bin; recovery must never restore its database
      // location from a timeout alone.
      const claimedMovement = await tx.movement.updateMany({
        where: { id: movement.id, status: { in: movement.type === "RETRIEVAL" ? ["AWAITING_VERIFICATION"] : PRE_MOTION_STATUSES } },
        data: {
          status: "FAILED",
          completedAt: now,
          ...(movement.type === "RETRIEVAL" ? {} : { idempotencyKey: null }),
        },
      });
      if (claimedMovement.count !== 1) throw new PutawayRecoveryRace();

      if (capture) {
        await tx.cameraCaptureJob.updateMany({
          where: {
            workflowCaptureId: capture.id,
            status: { in: ACTIVE_CAMERA_JOB_STATUSES },
          },
          data: {
            status: "FAILED",
            completedAt: now,
            updatedAt: now,
            errorCode: "putaway_abandoned_after_timeout",
            errorMessage: "The owning putaway verification expired after operator inactivity.",
          },
        });
      }

      // Checkout has already moved the bin. Expiring its check must neither
      // restore a shelf location nor allow the same request to move it twice.
      if (movement.type === "RETRIEVAL") return true;
      if (movement.destinationBinId) {
        await tx.bin.updateMany({
          where: { id: movement.destinationBinId, status: "RESERVED" },
          data: { status: destinationStatusBeforeReservation(movement) },
        });
      }
      if (
        movement.sourceLocation === "OUTPUT" &&
        movement.sourceBinId &&
        movement.sourceBinId !== movement.destinationBinId
      ) {
        await tx.bin.updateMany({
          where: { id: movement.sourceBinId, status: "RESERVED" },
          data: { status: "CHECKED_OUT" },
        });
      }
      return true;
    });
  } catch (error) {
    if (error instanceof PutawayRecoveryRace) return false;
    throw error;
  }
}

export interface PutawayRecoveryResult {
  recoveredMovementIds: string[];
}

/**
 * Releases abandoned putaways only while their durable Movement proves the
 * gantry has not started. A possibly-moving physical bin is never inferred
 * from a database timeout.
 */
export async function recoverAbandonedPutaways(
  now = new Date(),
): Promise<PutawayRecoveryResult> {
  const cutoff = new Date(now.getTime() - inactivityTimeoutMs());
  const failedCutoff = new Date(now.getTime() - FAILED_CAPTURE_RECOVERY_GRACE_MS);
  const [withCapture, failedCapture, withoutCapture] = await Promise.all([
    prisma.putawayCaptureRequest.findMany({
      where: {
        status: { in: ACTIVE_CAPTURE_STATUSES },
        updatedAt: { lte: cutoff },
        movement: { OR: [
          { type: "PUTAWAY", status: { in: PRE_MOTION_STATUSES } },
          { type: "RETRIEVAL", status: "AWAITING_VERIFICATION" },
        ] },
      },
      include: { movement: true },
    }),
    // Normally the still-live request observes FAILED and releases its own
    // reservation. If that request died too, a short grace lets recovery do
    // the same cleanup without waiting for the full human timeout.
    prisma.putawayCaptureRequest.findMany({
      where: {
        status: "FAILED",
        updatedAt: { lte: failedCutoff },
        movement: { OR: [
          { type: "PUTAWAY", status: { in: PRE_MOTION_STATUSES } },
          { type: "RETRIEVAL", status: "AWAITING_VERIFICATION" },
        ] },
      },
      include: { movement: true },
    }),
    prisma.movement.findMany({
      where: {
        OR: [
          { type: "PUTAWAY", status: { in: PRE_MOTION_STATUSES } },
          { type: "RETRIEVAL", status: "AWAITING_VERIFICATION" },
        ],
        createdAt: { lte: cutoff },
        putawayCapture: null,
      },
    }),
  ]);

  const recoveredMovementIds: string[] = [];
  for (const row of withCapture) {
    if (await releasePreMotionMovement(row.movement, row, cutoff, now)) {
      recoveredMovementIds.push(row.movementId);
    }
  }
  for (const row of failedCapture) {
    if (await releasePreMotionMovement(row.movement, row, failedCutoff, now)) {
      recoveredMovementIds.push(row.movementId);
    }
  }
  for (const movement of withoutCapture) {
    if (await releasePreMotionMovement(movement, null, cutoff, now)) {
      recoveredMovementIds.push(movement.id);
    }
  }

  if (recoveredMovementIds.length > 0) {
    console.warn(
      `[putaway] recovered abandoned pre-motion movements=${recoveredMovementIds.join(",")}`,
    );
  }
  return { recoveredMovementIds };
}

export function putawayInactivityTimeoutMs(): number {
  return inactivityTimeoutMs();
}
