import { getGantryMode } from "@/lib/gantry/factory";
import { prisma } from "./db";

const ACTIVE_AUDIT_KEY = "ACTIVE";
const RECOVERY_GRACE_MS = 30_000;
const NO_CAPTURE_RECOVERY_MS = 120_000;
const PROCESSING_RECOVERY_MS = 5 * 60_000;
const ABANDONED_HUMAN_WORKFLOW_MS = 24 * 60 * 60_000;

const UNFINISHED_AUDIT_STATUSES = ["PENDING", "RUNNING"];
const ACTIVE_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  "CAPTURING",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
  "PENDING_ACK",
];
const ACTIVE_CAMERA_JOB_STATUSES = [
  "PENDING",
  "CLAIMED",
  "UPLOADED",
  "PROCESSING",
];

export interface ActiveInventoryAuditSummary {
  auditRunId: string;
  binCode: string | null;
  startedAt: Date;
}

export class InventoryAuditAlreadyRunningError extends Error {
  readonly code = "audit_already_running";

  constructor(
    readonly active: ActiveInventoryAuditSummary,
    readonly requestedBinCode: string | null,
  ) {
    const activeTarget = active.binCode
      ? `bin ${active.binCode}`
      : "the warehouse";
    const requestedTarget = requestedBinCode
      ? ` Bin ${requestedBinCode} was not started.`
      : " The requested warehouse audit was not started.";
    super(
      `audit_already_running: An inventory audit for ${activeTarget} is still active.${requestedTarget}`,
    );
    this.name = "InventoryAuditAlreadyRunningError";
  }
}

async function loadActiveAudit() {
  return prisma.inventoryAuditRun.findUnique({
    where: { activeKey: ACTIVE_AUDIT_KEY },
    include: {
      binAudits: {
        orderBy: { createdAt: "asc" },
        include: {
          bin: {
            include: {
              inventory: {
                where: { quantity: { gt: 0 } },
                select: { quantity: true },
              },
            },
          },
          capture: true,
        },
      },
    },
  });
}

function summarizeActiveAudit(
  run: NonNullable<Awaited<ReturnType<typeof loadActiveAudit>>>,
): ActiveInventoryAuditSummary {
  const unfinished = run.binAudits.find((audit) =>
    UNFINISHED_AUDIT_STATUSES.includes(audit.status),
  );
  return {
    auditRunId: run.id,
    binCode: unfinished?.bin.code ?? run.requestedBinCode ?? null,
    startedAt: run.startedAt,
  };
}

export async function getActiveInventoryAuditSummary(): Promise<ActiveInventoryAuditSummary | null> {
  const run = await loadActiveAudit();
  return run ? summarizeActiveAudit(run) : null;
}

/**
 * Returns true only when the durable rows prove that the owning request can
 * no longer be making useful progress. A grace period lets the original
 * request perform its normal timeout/return cleanup before recovery steps in.
 */
async function isRecoverableAudit(
  run: NonNullable<Awaited<ReturnType<typeof loadActiveAudit>>>,
  now: Date,
): Promise<boolean> {
  const unfinished = run.binAudits.filter((audit) =>
    UNFINISHED_AUDIT_STATUSES.includes(audit.status),
  );

  if (unfinished.length === 0) {
    const latestCompletion = run.binAudits.reduce<Date | null>(
      (latest, audit) =>
        audit.completedAt && (!latest || audit.completedAt > latest)
          ? audit.completedAt
          : latest,
      null,
    );
    const lastProgress = latestCompletion ?? run.startedAt;
    return lastProgress.getTime() <= now.getTime() - RECOVERY_GRACE_MS;
  }

  for (const audit of unfinished) {
    const capture = audit.capture;
    if (!capture) {
      if (audit.startedAt.getTime() <= now.getTime() - NO_CAPTURE_RECOVERY_MS) {
        return true;
      }
      continue;
    }

    if (!ACTIVE_CAPTURE_STATUSES.includes(capture.status)) {
      if (capture.updatedAt.getTime() <= now.getTime() - RECOVERY_GRACE_MS) {
        return true;
      }
      continue;
    }
    // Human-facing states own no short lease. Only a full day without any
    // progress qualifies them for abandonment recovery.
    if (capture.status !== "CAPTURING") {
      if (capture.updatedAt.getTime() <= now.getTime() - ABANDONED_HUMAN_WORKFLOW_MS) {
        return true;
      }
      continue;
    }

    // CAPTURING is server-owned work and must keep renewing its lease.
    if (!capture.expiresAt
      || capture.expiresAt.getTime() > now.getTime() - RECOVERY_GRACE_MS) continue;

    const processingJob = await prisma.cameraCaptureJob.findFirst({
      where: {
        workflowCaptureId: capture.id,
        status: { in: ["UPLOADED", "PROCESSING"] },
        updatedAt: { gt: new Date(now.getTime() - PROCESSING_RECOVERY_MS) },
      },
      select: { id: true },
    });
    if (!processingJob) return true;
  }

  return false;
}

export interface InventoryAuditRecoveryResult {
  recovered: boolean;
  auditRunId: string | null;
  affectedBins: string[];
}

/**
 * Atomically releases a provably abandoned global audit lock.
 *
 * Simulation state is process-local, so after a request/server restart an
 * AUDITING bin can be restored from authoritative inventory. For a future
 * hardware controller, physical position cannot be inferred from a database
 * timeout; quarantine the bin instead of claiming it is back on the shelf.
 */
export async function recoverStaleInventoryAudit(
  now = new Date(),
): Promise<InventoryAuditRecoveryResult> {
  const run = await loadActiveAudit();
  if (!run || !(await isRecoverableAudit(run, now))) {
    return { recovered: false, auditRunId: run?.id ?? null, affectedBins: [] };
  }

  const unfinished = run.binAudits.filter((audit) =>
    UNFINISHED_AUDIT_STATUSES.includes(audit.status),
  );
  const unfinishedIds = unfinished.map((audit) => audit.id);
  const captureIds = unfinished
    .map((audit) => audit.capture?.id ?? null)
    .filter((id): id is string => id !== null);
  const acknowledgementIds = run.binAudits
    .filter(
      (audit) =>
        !UNFINISHED_AUDIT_STATUSES.includes(audit.status) &&
        audit.capture?.status === "PENDING_ACK",
    )
    .map((audit) => audit.capture!.id);
  const affectedBins = unfinished
    .filter((audit) => audit.bin.status === "AUDITING")
    .map((audit) => audit.bin.code);
  const simulation = getGantryMode() === "SIMULATION";
  const reason = "audit_abandoned_after_timeout";

  const recovered = await prisma.$transaction(async (tx) => {
    const claimed = await tx.inventoryAuditRun.updateMany({
      where: {
        id: run.id,
        activeKey: ACTIVE_AUDIT_KEY,
        status: run.status,
      },
      data: { status: "RECOVERING" },
    });
    if (claimed.count !== 1) return false;

    if (captureIds.length > 0) {
      await tx.cameraCaptureJob.updateMany({
        where: {
          workflowCaptureId: { in: captureIds },
          status: { in: ACTIVE_CAMERA_JOB_STATUSES },
        },
        data: {
          status: "FAILED",
          errorCode: reason,
          errorMessage: "The owning audit request ended before camera processing completed.",
          completedAt: now,
          updatedAt: now,
        },
      });
      await tx.auditCaptureRequest.updateMany({
        where: {
          id: { in: captureIds },
          status: { in: ACTIVE_CAPTURE_STATUSES },
        },
        data: { status: "FAILED", errorCode: reason },
      });
    }

    // PENDING_ACK means the deterministic result and any inventory write are
    // already final; only the UI acknowledgement was lost with the request.
    if (acknowledgementIds.length > 0) {
      await tx.auditCaptureRequest.updateMany({
        where: { id: { in: acknowledgementIds }, status: "PENDING_ACK" },
        data: { status: "ACCEPTED" },
      });
    }

    if (unfinishedIds.length > 0) {
      await tx.binAudit.updateMany({
        where: { id: { in: unfinishedIds } },
        data: {
          status: "FAILED",
          errorCode: reason,
          errorMessage: "The audit was recovered after its camera workflow expired.",
          completedAt: now,
        },
      });
    }

    for (const audit of unfinished) {
      if (audit.bin.status !== "AUDITING") continue;
      const recordedQuantity = audit.bin.inventory.reduce(
        (total, row) => total + row.quantity,
        0,
      );
      await tx.bin.updateMany({
        where: { id: audit.binId, status: "AUDITING" },
        data: {
          status: simulation
            ? recordedQuantity > 0
              ? "OCCUPIED"
              : "AVAILABLE"
            : "DISABLED",
        },
      });
    }

    const allAudits = await tx.binAudit.findMany({
      where: { auditRunId: run.id },
      select: { status: true },
    });
    const failedBins = allAudits.filter((audit) => audit.status === "FAILED").length;
    const verifiedBins = allAudits.filter(
      (audit) => audit.status === "VERIFIED",
    ).length;
    const reconciledBins = allAudits.filter(
      (audit) => audit.status === "AUTO_RECONCILED",
    ).length;
    const reviewRequiredBins = allAudits.filter(
      (audit) => audit.status === "REVIEW_REQUIRED" || audit.status === "DISMISSED",
    ).length;

    await tx.inventoryAuditRun.update({
      where: { id: run.id },
      data: {
        status:
          unfinished.length > 0
            ? "FAILED"
            : failedBins > 0 || reviewRequiredBins > 0
              ? "COMPLETED_WITH_ISSUES"
              : "COMPLETED",
        activeKey: null,
        binsCompleted: allAudits.length,
        verifiedBins,
        reconciledBins,
        failedBins,
        reviewRequiredBins,
        completedAt: now,
      },
    });
    return true;
  });

  if (recovered) {
    console.warn(
      `[inventory-audit] Recovered stale run ${run.id}; bins=${affectedBins.join(",") || "none"}`,
    );
  }
  return {
    recovered,
    auditRunId: recovered ? run.id : null,
    affectedBins: recovered ? affectedBins : [],
  };
}
