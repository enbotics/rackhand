import sharp from "sharp";
import {
  captureProcessingHeartbeatMilliseconds,
  createCaptureJob,
} from "@/lib/camera/capture-job-service";
import { prisma } from "./db";
import { getGantryController } from "@/lib/gantry/factory";
import { setInventoryQuantity } from "./inventory-service";
import {
  assessBinInspection,
  inspectBinImage,
} from "./bin-inspection-service";
import {
  getAuditCaptureMode,
  isOutOfSimulationScope,
  isSimulationEligibleBin,
  SimulationScopeError,
} from "./audit-capture-mode";
import { captureProcessingDeadline } from "./capture-deadlines";
import { scheduleSimulationRevert } from "./simulation-revert";
import {
  clearSimulatedWorkflowCapture,
  hasSimulationEvidence,
  isSimulationEvidenceUrl,
  isSimulatedWorkflowCapture,
  markSimulatedWorkflowCapture,
  nextSimulationEvidence,
  simulationBaselineUrl,
} from "./simulation-evidence";
import {
  AUDIT_CAPTURE_CONFIDENCE_THRESHOLD,
  type AuditCaptureDecision,
  type AuditCaptureOutcome,
  type AuditCaptureView,
} from "./audit-capture-types";
import {
  confidencePercent,
  type AuditVisionResult,
  type BinAuditOutcomeStatus,
  type BinAuditResult,
} from "./audit-types";
import { getContextWorkflowSessionId } from "@/lib/agents/request-context";

const CAPTURE_POLL_MS = 400;
/**
 * Statuses a legitimate retry may reset from. PENDING_ACK is deliberately
 * excluded because the observation is already trusted and only awaits either
 * a manual write decision or the no-write automatic return.
 */
const RETRYABLE_CAPTURE_STATUSES = ["REVIEW_DECREASE", "RETRY_REQUIRED"];
const RECOVERABLE_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  "PENDING_ACK",
  ...RETRYABLE_CAPTURE_STATUSES,
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuditSimulationMode(): boolean {
  return getAuditCaptureMode() === "SIMULATION";
}

/**
 * This bin's most recent ACCEPTED evidence — the "before" half of the
 * comparison dialog. Accepted means a putaway verification (always trusted
 * once written) or a past audit that actually landed on VERIFIED,
 * AUTO_RECONCILED or CONFIRMED — never a REVIEW_REQUIRED/FAILED/DISMISSED
 * audit's photo, which was never trusted as this bin's true state.
 */
async function findLatestAcceptedSnapshot(binId: string): Promise<string | null> {
  const [putaway, audit] = await Promise.all([
    prisma.movement.findFirst({
      where: { destinationBinId: binId, verificationImageUrl: { not: null }, verificationCapturedAt: { not: null } },
      orderBy: { verificationCapturedAt: "desc" },
      select: { verificationImageUrl: true, verificationCapturedAt: true },
    }),
    prisma.binAudit.findFirst({
      where: {
        binId,
        evidenceUrl: { not: null },
        capturedAt: { not: null },
        status: { in: ["VERIFIED", "AUTO_RECONCILED", "CONFIRMED"] },
      },
      orderBy: { capturedAt: "desc" },
      select: { evidenceUrl: true, capturedAt: true },
    }),
  ]);
  if (!putaway) return audit?.evidenceUrl ?? null;
  if (!audit) return putaway.verificationImageUrl;
  return putaway.verificationCapturedAt! >= audit.capturedAt!
    ? putaway.verificationImageUrl
    : audit.evidenceUrl;
}

async function failAudit(
  binAuditId: string,
  binCode: string,
  expectedQuantity: number,
  reason: string,
  captureMode: "PROD" | "SIMULATION" = "PROD",
): Promise<BinAuditResult> {
  const existing = await prisma.binAudit.findUnique({
    where: { id: binAuditId },
    select: { evidenceUrl: true },
  });
  await prisma.binAudit.update({
    where: { id: binAuditId },
    data: { status: "FAILED", errorCode: reason, errorMessage: reason, completedAt: new Date() },
  });
  return {
    captureMode,
    binAuditId,
    binCode,
    status: "FAILED",
    expectedQuantity,
    observedQuantity: null,
    confidence: null,
    confidencePercent: null,
    inventoryUpdated: false,
    previousQuantity: expectedQuantity,
    newQuantity: null,
    evidenceUrl: existing?.evidenceUrl ?? null,
    reason,
  };
}

/**
 * Audit-specific decision policy for a real or simulated capture. The shared
 * inspection service handles evidence safety; this function alone decides how
 * a safe expected/observed comparison affects audit reconciliation. Gemini
 * itself never authorizes a database update.
 */
export function classifyAuditVision(
  vision: AuditVisionResult,
  expected: { quantity: number; partId: string | null; capacity: number },
): AuditCaptureOutcome | "UNEXPECTED_STOCK" {
  const assessment = assessBinInspection(vision, {
    confidenceThreshold: AUDIT_CAPTURE_CONFIDENCE_THRESHOLD,
    capacity: expected.capacity,
    requireExpectedPart: expected.partId !== null,
  });
  if (assessment.gate !== "CLEAR") return assessment.gate;

  if (expected.partId === null) {
    return assessment.observedQuantity > 0 ? "UNEXPECTED_STOCK" : "VERIFIED";
  }
  if (assessment.observedQuantity === expected.quantity) return "VERIFIED";
  return assessment.observedQuantity > expected.quantity
    ? "AUTO_RECONCILED"
    : "REVIEW_DECREASE";
}

type CaptureWaitResult =
  /** finalized: the database write (if any) is already complete — Inventory and BinAudit are final. */
  | { ok: true; finalized: true; evidenceUrl: string; vision: AuditVisionResult }
  /** A trusted/idle run gave up on a REVIEW_DECREASE/RETRY_REQUIRED nobody was there to answer — the caller must still apply it. */
  | { ok: true; finalized: false; evidenceUrl: string; vision: AuditVisionResult }
  | { ok: false; reason: string };

function visionFromCaptureRow(capture: {
  countable: boolean | null;
  observedQuantity: number | null;
  countConfidence: number | null;
  expectedPartPresent: boolean | null;
  foreignObjectSuspected: boolean | null;
  foreignObjectsJson: string | null;
  occlusion: string | null;
  notes: string | null;
}): AuditVisionResult {
  let foreignObjects: string[] = [];
  let malformedForeignObjects = false;
  if (capture.foreignObjectsJson) {
    try {
      const parsed: unknown = JSON.parse(capture.foreignObjectsJson);
      if (Array.isArray(parsed)) {
        foreignObjects = parsed.filter((item): item is string => typeof item === "string").slice(0, 8);
      }
    } catch {
      // A malformed historical field is unsafe evidence, not a reason to kill
      // the recovery stream. Zero confidence below keeps it in manual review.
      malformedForeignObjects = true;
    }
  }
  return {
    countable: capture.countable ?? true,
    observedCount: capture.observedQuantity,
    countConfidence: malformedForeignObjects ? 0 : capture.countConfidence ?? 0,
    expectedPartPresent: capture.expectedPartPresent ?? true,
    foreignObjectSuspected: capture.foreignObjectSuspected ?? false,
    foreignObjects,
    occlusion: (capture.occlusion as AuditVisionResult["occlusion"]) ?? "NONE",
    notes: capture.notes ?? "",
  };
}

/**
 * Finish an analyzed audit without accepting its quantity. This is the
 * timeout path (and the equivalent explicit dismissal): evidence is retained,
 * the audit is terminal, the bin lock is released, and Inventory is untouched.
 */
async function returnAuditCaptureWithoutInventory(
  captureId: string,
  reason: "audit_auto_returned" | "audit_dismissed_by_operator",
): Promise<void> {
  const capture = await prisma.auditCaptureRequest.findUnique({
    where: { id: captureId },
    include: { binAudit: { include: { bin: true } } },
  });
  if (
    !capture ||
    !["PENDING_ACK", "REVIEW_DECREASE", "RETRY_REQUIRED"].includes(
      capture.status,
    )
  ) {
    throw new Error("audit_capture_not_pending");
  }

  const originalStatus =
    capture.expectedQuantity > 0 ? "OCCUPIED" : "AVAILABLE";
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.auditCaptureRequest.updateMany({
      where: { id: captureId, status: capture.status },
      data: { status: "FINALIZING" },
    });
    if (claimed.count !== 1) throw new Error("audit_capture_not_pending");

    const released = await tx.bin.updateMany({
      where: { id: capture.binAudit.binId, status: "AUDITING" },
      data: { status: originalStatus },
    });
    if (released.count !== 1) throw new Error("audit_lock_lost");

    await tx.binAudit.update({
      where: { id: capture.binAudit.id },
      data: {
        status: "DISMISSED",
        observedQuantity: capture.observedQuantity,
        countConfidence: capture.countConfidence,
        countable: capture.countable,
        expectedPartPresent: capture.expectedPartPresent,
        foreignObjectSuspected: capture.foreignObjectSuspected,
        occlusion: capture.occlusion,
        notes: capture.notes,
        evidenceUrl: capture.evidenceUrl,
        priorEvidenceUrl: capture.previousImageUrl,
        capturedAt: capture.capturedAt,
        inventoryUpdated: false,
        previousQuantity: capture.expectedQuantity,
        newQuantity: null,
        errorCode: reason,
        errorMessage:
          reason === "audit_auto_returned"
            ? "The confirmation window elapsed; the bin was returned without changing inventory."
            : "The operator dismissed this observation without changing inventory.",
        completedAt: new Date(),
      },
    });
    await tx.auditCaptureRequest.update({
      where: { id: captureId },
      data: { status: "ACCEPTED" },
    });
  });
}

/** Durable browser recovery for capture, review and acknowledgement states. */
export async function pendingAuditCapture(ownerSessionId: string) {
  const capture = await prisma.auditCaptureRequest.findFirst({
    where: {
      status: { in: RECOVERABLE_CAPTURE_STATUSES },
      ownerSessionId,
      binAudit: { auditRun: { activeKey: "ACTIVE" } },
    },
    orderBy: { createdAt: "asc" },
    include: {
      binAudit: { include: { bin: true, auditRun: true } },
    },
  });
  if (!capture) return { captureId: null };

  const captureMode = isSimulatedWorkflowCapture(capture.id)
    || (isAuditSimulationMode() && isSimulationEligibleBin(capture.binAudit.bin.code))
    ? "SIMULATION" as const
    : "PROD" as const;

  let analysis: AuditCaptureView | null = null;
  if (capture.status !== "WAITING_FOR_CAMERA") {
    const vision = visionFromCaptureRow(capture);
    const outcome = classifyAuditVision(vision, {
      quantity: capture.expectedQuantity,
      partId: capture.binAudit.expectedPartId,
      capacity: capture.binAudit.bin.capacity,
    });
    const foreignObjects = vision.foreignObjects ?? [];
    analysis = {
      captureMode,
      captureId: capture.id,
      binCode: capture.binAudit.bin.code,
      status: capture.status,
      outcome: DISPLAY_CAPTURE_OUTCOME[outcome],
      expectedQuantity: capture.expectedQuantity,
      observedQuantity: capture.observedQuantity,
      confidencePercent: capture.countConfidence === null
        ? null
        : confidencePercent(capture.countConfidence),
      previousImageUrl: capture.previousImageUrl,
      currentImageUrl: capture.evidenceUrl,
      foreignObjects,
      notes: capture.notes,
    };
  }

  return {
    captureId: capture.id,
    auditRunId: capture.binAudit.auditRunId,
    binAuditId: capture.binAuditId,
    binCode: capture.binAudit.bin.code,
    purpose: "AUDIT" as const,
    captureMode,
    status: capture.status,
    expiresAt: capture.expiresAt?.toISOString() ?? null,
    analysis,
  };
}

/** Extracts the foreign-object names Gemini reported, never their count. */
function foreignObjectNames(vision: AuditVisionResult): string[] {
  return vision.foreignObjects ?? [];
}

const UNSAFE_REASON: Record<Exclude<AuditCaptureOutcome, "VERIFIED" | "AUTO_RECONCILED"> | "UNEXPECTED_STOCK", string> = {
  REVIEW_DECREASE: "audit_pending_confirmation",
  LOW_CONFIDENCE: "audit_observation_unsafe",
  CAPACITY_EXCEEDED: "audit_capacity_exceeded",
  FOREIGN_OBJECTS: "foreign_object_suspected",
  UNEXPECTED_STOCK: "physical_stock_without_record",
};

/**
 * Applies a terminal, database-changing outcome to one bin audit: the write
 * (if any), the BinAudit's own final status, and the bin's status. Called
 * from three places — a capture that classified straight to VERIFIED/
 * AUTO_RECONCILED/UNEXPECTED_STOCK with no human step, an explicit ACCEPT of
 * a REVIEW_DECREASE, and executeBinAudit giving up on an abandoned session —
 * so every write path shares one set of safety guards (staleness, capacity,
 * AUDITING lock) instead of three copies of them.
 */
async function applyAuditOutcome(input: {
  binAuditId: string;
  binId: string;
  originalStatus: string;
  expectedPartId: string | null;
  expectedQuantity: number;
  outcome: AuditCaptureOutcome | "UNEXPECTED_STOCK";
  vision: AuditVisionResult;
  evidenceUrl: string;
}): Promise<{ status: BinAuditOutcomeStatus; inventoryUpdated: boolean; newQuantity: number | null; reason?: string }> {
  const { binAuditId, binId, originalStatus, expectedPartId, expectedQuantity, outcome, vision, evidenceUrl } = input;
  const observed = vision.observedCount;
  // Computed fresh here rather than threaded in from the caller: this bin is
  // locked to one audit at a time (the AUDITING claim), so "latest accepted"
  // cannot have changed since capture started, and computing it once here
  // covers the real-capture, simulated and give-up callers identically.
  const priorEvidenceUrl = await findLatestAcceptedSnapshot(binId);

  if (outcome === "VERIFIED" || outcome === "AUTO_RECONCILED") {
    const inventoryUpdated = outcome === "AUTO_RECONCILED";
    const nextStatus = observed! > 0 ? "OCCUPIED" : "AVAILABLE";
    let failureReason: string | undefined;
    await prisma.$transaction(async (tx) => {
      if (inventoryUpdated) {
        const current = expectedPartId
          ? await tx.inventory.findUnique({ where: { partId_binId: { partId: expectedPartId, binId } } })
          : null;
        if (!current || current.quantity !== expectedQuantity) throw new Error("audit_inventory_stale");
        await tx.inventory.update({ where: { id: current.id }, data: { quantity: observed! } });
      }
      const released = await tx.bin.updateMany({ where: { id: binId, status: "AUDITING" }, data: { status: nextStatus } });
      if (released.count !== 1) throw new Error("audit_lock_lost");
    }).catch((error) => {
      failureReason = error instanceof Error ? error.message : "audit_reconciliation_failed";
    });
    if (failureReason) {
      await prisma.bin.updateMany({ where: { id: binId, status: "AUDITING" }, data: { status: originalStatus } });
      await prisma.binAudit.update({
        where: { id: binAuditId },
        data: { status: "REVIEW_REQUIRED", errorCode: failureReason, errorMessage: failureReason, completedAt: new Date() },
      });
      return { status: "REVIEW_REQUIRED", inventoryUpdated: false, newQuantity: null, reason: failureReason };
    }
    await prisma.binAudit.update({
      where: { id: binAuditId },
      data: {
        status: outcome,
        observedQuantity: observed,
        countConfidence: vision.countConfidence,
        countable: vision.countable,
        expectedPartPresent: vision.expectedPartPresent,
        foreignObjectSuspected: vision.foreignObjectSuspected,
        occlusion: vision.occlusion,
        notes: vision.notes,
        evidenceUrl,
        priorEvidenceUrl,
        inventoryUpdated,
        newQuantity: inventoryUpdated ? observed : null,
        completedAt: new Date(),
      },
    });
    return { status: outcome, inventoryUpdated, newQuantity: inventoryUpdated ? observed! : null };
  }

  // REVIEW_DECREASE explicit accept, or a give-up landing on any unsafe
  // outcome — never writes inventory, always releases the bin, always
  // records exactly why for later review.
  const reason = UNSAFE_REASON[outcome];
  const releaseStatus = outcome === "UNEXPECTED_STOCK" ? "DISABLED" : originalStatus;
  const released = await prisma.bin.updateMany({ where: { id: binId, status: "AUDITING" }, data: { status: releaseStatus } });
  await prisma.binAudit.update({
    where: { id: binAuditId },
    data: {
      status: "REVIEW_REQUIRED",
      observedQuantity: observed,
      countConfidence: vision.countConfidence,
      countable: vision.countable,
      expectedPartPresent: vision.expectedPartPresent,
      foreignObjectSuspected: vision.foreignObjectSuspected,
      occlusion: vision.occlusion,
      notes: vision.notes,
      evidenceUrl,
      priorEvidenceUrl,
      errorCode: released.count === 1 ? reason : "audit_lock_lost",
      errorMessage: released.count === 1 ? reason : "audit_lock_lost",
      completedAt: new Date(),
    },
  });
  return { status: "REVIEW_REQUIRED", inventoryUpdated: false, newQuantity: null, reason: released.count === 1 ? reason : "audit_lock_lost" };
}

async function waitForTerminalCapture(captureId: string, isTrusted: boolean): Promise<CaptureWaitResult> {
  while (true) {
    const capture = await prisma.auditCaptureRequest.findUnique({ where: { id: captureId } });
    if (!capture) return { ok: false, reason: "capture_request_missing" };
    if (capture.status === "FAILED") return { ok: false, reason: capture.errorCode ?? "capture_failed" };
    if (capture.status === "ACCEPTED") {
      return { ok: true, finalized: true, evidenceUrl: capture.evidenceUrl ?? "", vision: visionFromCaptureRow(capture) };
    }
    // A trusted/idle run has no one to click anything — not the dismissal
    // that would turn PENDING_ACK into ACCEPTED, and not an answer to a
    // REVIEW_DECREASE or RETRY_REQUIRED prompt. Waiting for either would be
    // an indefinite hang, so the very first analysis is final either way.
    if (isTrusted && capture.status === "PENDING_ACK" && capture.evidenceUrl) {
      // No operator is present to make a manual quantity-changing decision.
      // Close the observation exactly like the browser's five-second timeout:
      // return the bin and preserve recorded inventory.
      await returnAuditCaptureWithoutInventory(captureId, "audit_auto_returned");
      return { ok: true, finalized: true, evidenceUrl: capture.evidenceUrl, vision: visionFromCaptureRow(capture) };
    }
    if (isTrusted && (capture.status === "REVIEW_DECREASE" || capture.status === "RETRY_REQUIRED")) {
      return { ok: true, finalized: false, evidenceUrl: capture.evidenceUrl ?? "", vision: visionFromCaptureRow(capture) };
    }

    const now = new Date();
    if (capture.status === "CAPTURING" && capture.expiresAt
      && now.getTime() >= capture.expiresAt.getTime()) {
      const expired = await prisma.auditCaptureRequest.updateMany({
        where: {
          id: captureId,
          status: "CAPTURING",
          expiresAt: { lte: now },
        },
        data: { status: "FAILED", errorCode: "capture_station_unavailable" },
      });
      // A concurrent phase transition may have renewed expiresAt. In that
      // case this stale read cannot fail the new phase.
      if (expired.count === 0) continue;
      return { ok: false, reason: "capture_station_unavailable" };
    }
    await wait(CAPTURE_POLL_MS);
  }
}

/** Audits exactly one bin. The caller guarantees sequential execution. */
export async function executeBinAudit(
  binAuditId: string,
  ownerSessionId?: string | null,
): Promise<BinAuditResult> {
  const audit = await prisma.binAudit.findUnique({
    where: { id: binAuditId },
    include: { bin: true, expectedPart: true, auditRun: true },
  });
  if (!audit) throw new Error("bin_audit_not_found");
  const { bin } = audit;
  const originalStatus = bin.status;
  // Only a trusted idle-agent audit is unattended. Client audits belong to
  // their requesting browser and stop for any required human decision.
  const isTrusted = audit.auditRun.trigger === "TRUSTED_INTERNAL";
  // Refuse before touching bin/gantry state: Simulation mode must never
  // silently fall through to a real capture on a bin it doesn't cover.
  if (isOutOfSimulationScope(bin.code)) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "simulation_scope_violation", "SIMULATION");
  }
  const simulated = isAuditSimulationMode() && isSimulationEligibleBin(bin.code);
  const simulatedBaseline = simulated ? await simulationBaselineUrl(bin.code) : null;
  if (simulated && (!simulatedBaseline || !await hasSimulationEvidence(bin.code))) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_simulation_no_evidence", "SIMULATION");
  }
  if (!["AVAILABLE", "OCCUPIED"].includes(originalStatus)) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "bin_audit_conflict", simulated ? "SIMULATION" : "PROD");
  }

  const gantry = getGantryController();
  const claimed = await prisma.bin.updateMany({
    where: { id: bin.id, status: originalStatus },
    data: { status: "AUDITING" },
  });
  if (claimed.count !== 1) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "bin_audit_conflict", simulated ? "SIMULATION" : "PROD");
  }
  try {
    await prisma.binAudit.update({ where: { id: audit.id }, data: { status: "RUNNING" } });
  } catch (error) {
    await prisma.bin.updateMany({
      where: { id: bin.id, status: "AUDITING" },
      data: { status: originalStatus },
    });
    throw error;
  }

  const presented = await gantry.presentBinForAudit({ binCode: bin.code }).catch(() => null);
  if (!presented || presented.status !== "COMPLETED") {
    await prisma.bin.updateMany({ where: { id: bin.id, status: "AUDITING" }, data: { status: originalStatus } });
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_move_failed", simulated ? "SIMULATION" : "PROD");
  }

  // Physical safety: the bin stays at SCAN_STATION for the ENTIRE capture,
  // retry and confirmation dance below — it is only returned once a
  // terminal result exists (accepted, or this run has genuinely given up).
  let captured: CaptureWaitResult;
  let workflowCaptureId: string | null = null;
  try {
    const previousImageUrl = simulatedBaseline ?? await findLatestAcceptedSnapshot(bin.id);
    const capture = await prisma.auditCaptureRequest.create({
      data: {
        binAuditId: audit.id,
        ownerSessionId: ownerSessionId ?? getContextWorkflowSessionId(),
        status: "WAITING_FOR_CAMERA",
        expectedQuantity: audit.expectedQuantity,
        previousImageUrl,
        expiresAt: null,
      },
    });
    workflowCaptureId = capture.id;
    if (simulated) markSimulatedWorkflowCapture(capture.id);
    // ALWAYS auto-fire the capture — no operator click needed to START it,
    // for any trigger. This is a separate concern from `isTrusted` below:
    // "who presses the capture button" and "who decides on an ambiguous
    // read" used to be the same boolean, which is why unattended-only
    // auto-capture briefly existed. A client audit still has an operator
    // present to make that DECISION (waitForTerminalCapture(..., isTrusted)
    // below is unchanged and still waits for one), so REVIEW_DECREASE /
    // RETRY_REQUIRED / a low-confidence read still shows the interactive
    // retry-or-confirm popup exactly as before — only the "please press
    // capture" step is gone, universally.
    await requestAuditCameraCapture(capture.id);
    captured = await waitForTerminalCapture(capture.id, isTrusted);
  } catch (error) {
    console.error(`[inventory-audit] capture handshake failed bin=${bin.code}`, error);
    captured = { ok: false, reason: "capture_handshake_failed" };
  }

  // Returning the bin is mandatory once a terminal result exists, whether
  // that is an accepted outcome, a hard failure, or this run giving up on an
  // unsafe result nobody was available to act on.
  const returned = await gantry.returnBinFromAudit({ binCode: bin.code }).catch(() => null);
  if (!returned || returned.status !== "COMPLETED") {
    // AUDITING deliberately remains set: physical location is uncertain.
    if (workflowCaptureId) clearSimulatedWorkflowCapture(workflowCaptureId);
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_return_failed", simulated ? "SIMULATION" : "PROD");
  }
  if (returned.status === "COMPLETED" && captured.ok && captured.finalized) {
    // An accepted result means nothing is carried on the arm — safe to park.
    await gantry.home().catch((error) => {
      console.error(`[inventory-audit] post-audit home failed bin=${bin.code}`, error);
    });
  }

  if (!captured.ok) {
    if (workflowCaptureId) clearSimulatedWorkflowCapture(workflowCaptureId);
    await prisma.bin.updateMany({ where: { id: bin.id, status: "AUDITING" }, data: { status: originalStatus } });
    return failAudit(audit.id, bin.code, audit.expectedQuantity, captured.reason, simulated ? "SIMULATION" : "PROD");
  }

  const { vision, evidenceUrl } = captured;

  if (!captured.finalized) {
    // Simulation (no operator ever finalizes it), and a trusted/idle run
    // whose result nobody was there to answer, both finalize right here.
    const outcome = classifyAuditVision(vision, {
      quantity: audit.expectedQuantity,
      partId: audit.expectedPartId,
      capacity: bin.capacity,
    });
    const applied = await applyAuditOutcome({
      binAuditId: audit.id,
      binId: bin.id,
      originalStatus,
      expectedPartId: audit.expectedPartId,
      expectedQuantity: audit.expectedQuantity,
      outcome,
      vision,
      evidenceUrl,
    });
    if (workflowCaptureId) clearSimulatedWorkflowCapture(workflowCaptureId);
    return {
      captureMode: simulated ? "SIMULATION" : "PROD",
      binAuditId: audit.id,
      binCode: bin.code,
      status: applied.status,
      expectedQuantity: audit.expectedQuantity,
      observedQuantity: vision.observedCount,
      confidence: vision.countConfidence,
      confidencePercent: confidencePercent(vision.countConfidence),
      inventoryUpdated: applied.inventoryUpdated,
      previousQuantity: audit.expectedQuantity,
      newQuantity: applied.newQuantity,
      evidenceUrl,
      ...(applied.reason ? { reason: applied.reason } : {}),
    };
  }

  // The operator's decision, or the no-write automatic return, already
  // finalized this BinAudit row via the capture/decision route. Read that
  // authoritative result back rather than recomputing it.
  const finalAudit = await prisma.binAudit.findUniqueOrThrow({ where: { id: audit.id } });
  if (workflowCaptureId) clearSimulatedWorkflowCapture(workflowCaptureId);
  return {
    captureMode: simulated ? "SIMULATION" : "PROD",
    binAuditId: audit.id,
    binCode: bin.code,
    status: finalAudit.status as BinAuditOutcomeStatus,
    expectedQuantity: audit.expectedQuantity,
    observedQuantity: finalAudit.observedQuantity,
    confidence: finalAudit.countConfidence,
    confidencePercent: finalAudit.countConfidence === null ? null : confidencePercent(finalAudit.countConfidence),
    inventoryUpdated: finalAudit.inventoryUpdated,
    previousQuantity: audit.expectedQuantity,
    newQuantity: finalAudit.newQuantity,
    evidenceUrl: finalAudit.evidenceUrl,
    ...(finalAudit.errorCode ? { reason: finalAudit.errorCode } : {}),
  };
}

/**
 * Classifies one freshly captured audit frame. Every actionable observation
 * persists and waits for either a manual decision or the five-second no-write
 * return. Unexpected stock remains terminal because there is no catalog row
 * to update.
 */
export async function classifyAndPersistAuditCapture(input: {
  captureId: string;
  binAuditId: string;
  binId: string;
  binCode: string;
  originalStatus: string;
  expectedPartId: string | null;
  expectedQuantity: number;
  capacity: number;
  vision: AuditVisionResult;
  evidenceUrl: string;
  capturedAt?: Date;
  workflowAttempt: number;
}): Promise<{ outcome: AuditCaptureOutcome | "UNEXPECTED_STOCK"; status: string }> {
  const outcome = classifyAuditVision(input.vision, {
    quantity: input.expectedQuantity,
    partId: input.expectedPartId,
    capacity: input.capacity,
  });
  const foreignObjectsJson = JSON.stringify(foreignObjectNames(input.vision));
  const capturedAt = input.capturedAt ?? new Date();

  if (outcome === "REVIEW_DECREASE" || outcome === "LOW_CONFIDENCE" || outcome === "CAPACITY_EXCEEDED" || outcome === "FOREIGN_OBJECTS") {
    const status = outcome === "REVIEW_DECREASE" ? "REVIEW_DECREASE" : "RETRY_REQUIRED";
    const persisted = await prisma.auditCaptureRequest.updateMany({
      where: { id: input.captureId, status: "CAPTURING", attempt: input.workflowAttempt },
      data: {
        status,
        observedQuantity: input.vision.observedCount,
        countConfidence: input.vision.countConfidence,
        countable: input.vision.countable,
        expectedPartPresent: input.vision.expectedPartPresent,
        foreignObjectSuspected: input.vision.foreignObjectSuspected,
        foreignObjectsJson,
        occlusion: input.vision.occlusion,
        notes: input.vision.notes,
        evidenceUrl: input.evidenceUrl,
        capturedAt,
        expiresAt: null,
      },
    });
    if (persisted.count !== 1) throw new Error("audit_capture_attempt_superseded");
    return { outcome, status };
  }

  // Unexpected stock has no catalog row that a person could safely update,
  // so preserve its existing terminal handling. Equal and higher trusted
  // counts now wait in PENDING_ACK: a manual click applies the observation,
  // while AUTO_RETURN returns the bin with Inventory untouched.
  if (outcome === "UNEXPECTED_STOCK") {
    await applyAuditOutcome({
      binAuditId: input.binAuditId,
      binId: input.binId,
      originalStatus: input.originalStatus,
      expectedPartId: input.expectedPartId,
      expectedQuantity: input.expectedQuantity,
      outcome,
      vision: input.vision,
      evidenceUrl: input.evidenceUrl,
    });
  }
  const status = outcome === "UNEXPECTED_STOCK" ? "ACCEPTED" : "PENDING_ACK";
  const persisted = await prisma.auditCaptureRequest.updateMany({
    where: { id: input.captureId, status: "CAPTURING", attempt: input.workflowAttempt },
    data: {
      status,
      observedQuantity: input.vision.observedCount,
      countConfidence: input.vision.countConfidence,
      countable: input.vision.countable,
      expectedPartPresent: input.vision.expectedPartPresent,
      foreignObjectSuspected: input.vision.foreignObjectSuspected,
      foreignObjectsJson,
      occlusion: input.vision.occlusion,
      notes: input.vision.notes,
      evidenceUrl: input.evidenceUrl,
      capturedAt,
      expiresAt: null,
    },
  });
  if (persisted.count !== 1) throw new Error("audit_capture_attempt_superseded");
  return { outcome, status };
}

const DISPLAY_CAPTURE_OUTCOME: Record<
  AuditCaptureOutcome | "UNEXPECTED_STOCK",
  AuditCaptureOutcome
> = {
  VERIFIED: "VERIFIED",
  AUTO_RECONCILED: "AUTO_RECONCILED",
  REVIEW_DECREASE: "REVIEW_DECREASE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  FOREIGN_OBJECTS: "FOREIGN_OBJECTS",
  UNEXPECTED_STOCK: "LOW_CONFIDENCE",
};

/** Analyze the next simulation fixture, or request one physical Pi frame. */
export async function requestAuditCameraCapture(
  id: string,
  ownerSessionId?: string,
): Promise<
  | { captureMode: "SIMULATION"; result: AuditCaptureView }
  | { captureMode: "PROD"; job: Awaited<ReturnType<typeof createCaptureJob>> }
> {
  const capture = await prisma.auditCaptureRequest.findUnique({
    where: { id },
    include: { binAudit: { include: { bin: true } } },
  });
  if (capture && ownerSessionId && capture.ownerSessionId !== ownerSessionId) {
    throw new Error("This audit capture belongs to another operator session.");
  }
  if (!capture || capture.status !== "WAITING_FOR_CAMERA") {
    throw new Error("This audit capture is stale or no longer pending.");
  }
  if (capture.binAudit.status !== "RUNNING" || capture.binAudit.bin.status !== "AUDITING") {
    throw new Error("This bin is no longer positioned for auditing.");
  }
  const binCode = capture.binAudit.bin.code;
  if (isOutOfSimulationScope(binCode)) {
    throw new SimulationScopeError(binCode);
  }
  const simulated = isSimulatedWorkflowCapture(id)
    || (isAuditSimulationMode() && isSimulationEligibleBin(binCode));
  if (simulated) {
    markSimulatedWorkflowCapture(id);
    const sample = await nextSimulationEvidence(binCode);
    const metadata = await sharp(sample.bytes).metadata();
    const requestedAt = new Date();
    const result = await processAuditCameraCapture(id, {
      imageBuffer: sample.bytes,
      evidenceUrl: sample.url,
      imageWidth: metadata.width ?? 1,
      imageHeight: metadata.height ?? 1,
      capturedAt: requestedAt,
      requestedAt,
      workflowAttempt: capture.attempt,
      captureMode: "SIMULATION",
    });
    return { captureMode: "SIMULATION", result };
  }

  const existing = await prisma.cameraCaptureJob.findFirst({
    where: {
      purpose: "INVENTORY_AUDIT",
      workflowCaptureId: id,
      status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
    },
    orderBy: { requestedAt: "desc" },
  });
  const job = existing ?? await createCaptureJob({
    purpose: "INVENTORY_AUDIT",
    ownerSessionId: capture.ownerSessionId,
    binAuditId: capture.binAuditId,
    workflowCaptureId: id,
    workflowAttempt: capture.attempt,
  });
  return { captureMode: "PROD", job };
}

/** Analyze a production or simulated frame through one shared audit policy. */
export async function processAuditCameraCapture(id: string, input: {
  imageBuffer: Buffer;
  evidenceUrl: string;
  imageWidth: number;
  imageHeight: number;
  capturedAt: Date;
  requestedAt: Date;
  workflowAttempt: number;
  captureMode?: "PROD" | "SIMULATION";
}): Promise<AuditCaptureView> {
  const captureMode = input.captureMode ?? "PROD";
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0
    || !input.evidenceUrl
    || !Number.isInteger(input.imageWidth) || input.imageWidth <= 0
    || !Number.isInteger(input.imageHeight) || input.imageHeight <= 0
    || !Number.isFinite(input.capturedAt.getTime())) {
    throw new Error("A fresh capture frame and valid metadata are required.");
  }
  const claimed = await prisma.auditCaptureRequest.updateMany({
    where: { id, status: "WAITING_FOR_CAMERA", attempt: input.workflowAttempt },
    data: {
      status: "CAPTURING",
      expiresAt: captureProcessingDeadline(),
    },
  });
  if (claimed.count !== 1) throw new Error("This audit capture is no longer pending.");

  let binAuditId: string | null = null;
  try {
    const capture = await prisma.auditCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: {
        binAudit: { include: { bin: true, auditRun: true, expectedPart: true } },
      },
    });
    binAuditId = capture.binAuditId;
    const { binAudit } = capture;
    if (binAudit.status !== "RUNNING" || binAudit.bin.status !== "AUDITING"
      || capture.attempt !== input.workflowAttempt
      || input.capturedAt.getTime() < input.requestedAt.getTime()
      || input.capturedAt.getTime() > Date.now() + 60_000) {
      throw new Error("This audit capture is stale or no longer pending.");
    }
    const part = binAudit.expectedPart;
    const leaseHeartbeat = setInterval(() => {
      void prisma.auditCaptureRequest.updateMany({
        where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
        data: { expiresAt: captureProcessingDeadline() },
      }).catch(() => {});
    }, captureProcessingHeartbeatMilliseconds());
    let vision: AuditVisionResult;
    try {
      vision = await inspectBinImage(input.imageBuffer, {
        binCode: binAudit.bin.code,
        sku: part?.sku ?? null,
        canonicalName: part?.canonicalName ?? null,
        dimensions: part
          ? { lengthMM: part.lengthMM, widthMM: part.widthMM, heightMM: part.heightMM }
          : null,
      });
    } finally {
      clearInterval(leaseHeartbeat);
    }
    const processingRenewed = await prisma.auditCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: { expiresAt: captureProcessingDeadline() },
    });
    if (processingRenewed.count !== 1) {
      throw new Error("This audit capture stopped being processable during image analysis.");
    }
    const { outcome, status } = await classifyAndPersistAuditCapture({
      captureId: id,
      binAuditId: binAudit.id,
      binId: binAudit.binId,
      binCode: binAudit.bin.code,
      originalStatus: binAudit.expectedQuantity > 0 ? "OCCUPIED" : "AVAILABLE",
      expectedPartId: binAudit.expectedPartId,
      expectedQuantity: capture.expectedQuantity,
      capacity: binAudit.bin.capacity,
      vision,
      evidenceUrl: input.evidenceUrl,
      capturedAt: input.capturedAt,
      workflowAttempt: input.workflowAttempt,
    });
    await prisma.auditCaptureRequest.update({
      where: { id },
      data: { imageWidth: input.imageWidth, imageHeight: input.imageHeight },
    });
    return {
      captureMode,
      captureId: id,
      binCode: binAudit.bin.code,
      status,
      outcome: DISPLAY_CAPTURE_OUTCOME[outcome],
      expectedQuantity: capture.expectedQuantity,
      observedQuantity: vision.observedCount,
      confidencePercent: confidencePercent(vision.countConfidence),
      previousImageUrl: capture.previousImageUrl,
      currentImageUrl: input.evidenceUrl,
      foreignObjects: vision.foreignObjects ?? [],
      notes: outcome === "UNEXPECTED_STOCK"
        ? `${vision.notes} No catalog record expects stock in this bin — resolve it from bin management, not this capture.`.trim()
        : vision.notes,
    };
  } catch (error) {
    console.error(`[inventory-audit] ${captureMode.toLowerCase()} capture failed id=${id}`, error);
    await prisma.auditCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: {
        status: "RETRY_REQUIRED",
        evidenceUrl: input.evidenceUrl,
        errorCode: "capture_failed",
        notes: captureMode === "SIMULATION"
          ? "The simulated frame could not be analyzed. Run the next simulated capture."
          : "The image could not be analyzed. Request a fresh Raspberry Pi photo.",
        expiresAt: null,
      },
    });
    if (binAuditId) {
      await prisma.binAudit.update({
        where: { id: binAuditId },
        data: { evidenceUrl: input.evidenceUrl, capturedAt: input.capturedAt },
      }).catch(() => {});
    }
    const failed = await prisma.auditCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { binAudit: { include: { bin: true } } },
    });
    return {
      captureMode,
      captureId: id,
      binCode: failed.binAudit.bin.code,
      status: "RETRY_REQUIRED",
      outcome: "LOW_CONFIDENCE",
      expectedQuantity: failed.expectedQuantity,
      observedQuantity: null,
      confidencePercent: null,
      previousImageUrl: failed.previousImageUrl,
      currentImageUrl: input.evidenceUrl,
      foreignObjects: [],
      notes: failed.notes,
    };
  }
}

/**
 * A human's decision on a pending audit capture: ACCEPT either acknowledges an
 * already-applied automatic result (PENDING_ACK) so the bin can be returned,
 * or explicitly confirms a REVIEW_DECREASE (which writes Inventory only
 * now). RETRY resets the same row for the next capture — reused, never
 * duplicated. DISMISS records the observation as skipped without changing
 * inventory, then permits this bin to return before the next audit starts.
 * Human capture/review states deliberately carry no short expiry.
 */
export async function decideAuditCapture(
  captureId: string,
  decision: AuditCaptureDecision,
  ownerSessionId?: string,
): Promise<void> {
  if (ownerSessionId) {
    const owner = await prisma.auditCaptureRequest.findUnique({
      where: { id: captureId },
      select: { ownerSessionId: true },
    });
    if (!owner || owner.ownerSessionId !== ownerSessionId) {
      throw new Error("This audit capture belongs to another operator session.");
    }
  }
  const capture = await prisma.auditCaptureRequest.findUnique({
    where: { id: captureId },
    include: { binAudit: { include: { bin: true, expectedPart: true } } },
  });
  if (!capture) throw new Error("audit_capture_not_found");

  if (decision === "AUTO_RETURN") {
    await returnAuditCaptureWithoutInventory(captureId, "audit_auto_returned");
    return;
  }

  if (decision === "RETRY") {
    if (!["WAITING_FOR_CAMERA", ...RETRYABLE_CAPTURE_STATUSES].includes(capture.status)) {
      throw new Error("audit_capture_not_retryable");
    }
    await prisma.$transaction(async (tx) => {
      const reset = await tx.auditCaptureRequest.updateMany({
        where: { id: captureId, status: capture.status },
        data: {
          status: "WAITING_FOR_CAMERA",
          observedQuantity: null,
          countConfidence: null,
          countable: null,
          expectedPartPresent: null,
          foreignObjectSuspected: null,
          foreignObjectsJson: null,
          occlusion: null,
          notes: null,
          evidenceUrl: null,
          imageWidth: null,
          imageHeight: null,
          capturedAt: null,
          errorCode: null,
          attempt: { increment: 1 },
          expiresAt: null,
        },
      });
      if (reset.count !== 1) throw new Error("audit_capture_not_retryable");
      await tx.cameraCaptureJob.updateMany({
        where: {
          workflowCaptureId: captureId,
          status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          errorCode: "camera_job_superseded",
          errorMessage: "A newer audit capture attempt replaced this capture.",
          updatedAt: new Date(),
        },
      });
    });
    return;
  }

  if (decision === "DISMISS") {
    // PENDING_ACK has not changed inventory yet. Dismissing it follows the
    // same no-write return path as the timer.
    if (capture.status === "PENDING_ACK") {
      await returnAuditCaptureWithoutInventory(captureId, "audit_dismissed_by_operator");
      return;
    }

    if (!["WAITING_FOR_CAMERA", ...RETRYABLE_CAPTURE_STATUSES].includes(capture.status)) {
      throw new Error("audit_capture_not_pending");
    }

    const originalStatus = capture.expectedQuantity > 0 ? "OCCUPIED" : "AVAILABLE";
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.auditCaptureRequest.updateMany({
        where: { id: captureId, status: capture.status },
        data: { status: "ACCEPTED" },
      });
      if (claimed.count !== 1) throw new Error("audit_capture_not_pending");

      const released = await tx.bin.updateMany({
        where: { id: capture.binAudit.binId, status: "AUDITING" },
        data: { status: originalStatus },
      });
      if (released.count !== 1) throw new Error("audit_lock_lost");

      await tx.binAudit.update({
        where: { id: capture.binAudit.id },
        data: {
          status: "DISMISSED",
          observedQuantity: capture.observedQuantity,
          countConfidence: capture.countConfidence,
          countable: capture.countable,
          expectedPartPresent: capture.expectedPartPresent,
          foreignObjectSuspected: capture.foreignObjectSuspected,
          occlusion: capture.occlusion,
          notes: capture.notes,
          evidenceUrl: capture.evidenceUrl,
          priorEvidenceUrl: capture.previousImageUrl,
          capturedAt: capture.capturedAt,
          inventoryUpdated: false,
          previousQuantity: capture.expectedQuantity,
          newQuantity: null,
          errorCode: "audit_dismissed_by_operator",
          errorMessage:
            capture.status === "WAITING_FOR_CAMERA"
              ? "The operator aborted this audit before a photo was verified."
              : "The operator skipped this observation without changing inventory.",
          completedAt: new Date(),
        },
      });
      await tx.cameraCaptureJob.updateMany({
        where: {
          workflowCaptureId: captureId,
          status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          errorCode: "camera_job_aborted",
          errorMessage: "The operator aborted this audit capture.",
          updatedAt: new Date(),
        },
      });
    });
    return;
  }

  // ACCEPT
  if (capture.status === "PENDING_ACK") {
    const claimed = await prisma.auditCaptureRequest.updateMany({
      where: { id: captureId, status: "PENDING_ACK" },
      data: { status: "FINALIZING" },
    });
    if (claimed.count !== 1) throw new Error("audit_capture_not_pending");

    const vision = visionFromCaptureRow(capture);
    const outcome = classifyAuditVision(vision, {
      quantity: capture.expectedQuantity,
      partId: capture.binAudit.expectedPartId,
      capacity: capture.binAudit.bin.capacity,
    });
    if (outcome !== "VERIFIED" && outcome !== "AUTO_RECONCILED") {
      await prisma.auditCaptureRequest.updateMany({
        where: { id: captureId, status: "FINALIZING" },
        data: { status: "PENDING_ACK" },
      });
      throw new Error("audit_capture_not_confirmable");
    }
    const applied = await applyAuditOutcome({
      binAuditId: capture.binAudit.id,
      binId: capture.binAudit.binId,
      originalStatus: capture.expectedQuantity > 0 ? "OCCUPIED" : "AVAILABLE",
      expectedPartId: capture.binAudit.expectedPartId,
      expectedQuantity: capture.expectedQuantity,
      outcome,
      vision,
      evidenceUrl: capture.evidenceUrl ?? "",
    });
    await prisma.auditCaptureRequest.updateMany({
      where: { id: captureId, status: "FINALIZING" },
      data: { status: "ACCEPTED" },
    });
    if (
      applied.inventoryUpdated &&
      isSimulatedWorkflowCapture(captureId) &&
      capture.binAudit.expectedPartId
    ) {
      scheduleSimulationRevert({
        partId: capture.binAudit.expectedPartId,
        binId: capture.binAudit.binId,
        previousQuantity: capture.expectedQuantity,
        source: "audit",
      });
    }
    return;
  }

  if (capture.status !== "REVIEW_DECREASE") throw new Error("audit_capture_not_pending");
  if (capture.observedQuantity === null) throw new Error("audit_capture_not_confirmable");

  // The operator explicitly accepted the lower count, so this records
  // CONFIRMED — never a bare REVIEW_REQUIRED, which is reserved for a
  // give-up nobody actually decided.
  const { binAudit } = capture;
  if (!binAudit.expectedPartId || !binAudit.expectedPart) throw new Error("audit_capture_not_confirmable");
  await prisma.$transaction(async (tx) => {
    // Claim the human decision before changing inventory. This row lock also
    // prevents the deadline watcher from expiring a confirmation in flight.
    const claimed = await tx.auditCaptureRequest.updateMany({
      where: { id: captureId, status: "REVIEW_DECREASE" },
      data: { status: "ACCEPTED" },
    });
    if (claimed.count !== 1) throw new Error("audit_capture_not_pending");

    const current = await tx.inventory.findUnique({
      where: { partId_binId: { partId: binAudit.expectedPartId!, binId: binAudit.binId } },
    });
    const currentQuantity = current?.quantity ?? 0;
    if (currentQuantity !== capture.expectedQuantity) {
      throw new Error("audit_inventory_stale");
    }

    const observedQuantity = capture.observedQuantity!;
    const inventoryUpdated = currentQuantity !== observedQuantity;
    if (inventoryUpdated) {
      if (!current) throw new Error("audit_inventory_stale");
      if (observedQuantity === 0) {
        await tx.inventory.delete({ where: { id: current.id } });
      } else {
        const updated = await tx.inventory.updateMany({
          where: { id: current.id, quantity: currentQuantity },
          data: { quantity: observedQuantity },
        });
        if (updated.count !== 1) throw new Error("audit_inventory_stale");
      }
      await tx.movement.create({
        data: {
          type: "ADJUSTMENT",
          partId: binAudit.expectedPartId!,
          quantity: Math.abs(currentQuantity - observedQuantity),
          status: "COMPLETED",
          destinationBinId: binAudit.binId,
          previousQuantity: currentQuantity,
          newQuantity: observedQuantity,
          completedAt: new Date(),
        },
      });
    }

    const released = await tx.bin.updateMany({
      where: { id: binAudit.binId, status: "AUDITING" },
      data: { status: observedQuantity > 0 ? "OCCUPIED" : "AVAILABLE" },
    });
    if (released.count !== 1) throw new Error("audit_lock_lost");

    await tx.binAudit.update({
      where: { id: binAudit.id },
      data: {
        status: "CONFIRMED",
        observedQuantity,
        countConfidence: capture.countConfidence,
        countable: capture.countable,
        expectedPartPresent: capture.expectedPartPresent,
        foreignObjectSuspected: capture.foreignObjectSuspected,
        occlusion: capture.occlusion,
        notes: capture.notes,
        evidenceUrl: capture.evidenceUrl,
        priorEvidenceUrl: capture.previousImageUrl,
        capturedAt: capture.capturedAt,
        inventoryUpdated,
        previousQuantity: currentQuantity,
        newQuantity: observedQuantity,
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
  });
  if (isSimulatedWorkflowCapture(captureId) && capture.binAudit.expectedPartId) {
    scheduleSimulationRevert({
      partId: capture.binAudit.expectedPartId,
      binId: capture.binAudit.binId,
      previousQuantity: capture.expectedQuantity,
      source: "audit",
    });
  }
}

export type ConfirmBinAuditDecision = "APPLY" | "DISMISS";

/** Serializes an already-loaded BinAudit row into the same result shape executeBinAudit returns. */
function toConfirmationResult(
  audit: {
    id: string;
    expectedQuantity: number;
    observedQuantity: number | null;
    countConfidence: number | null;
    evidenceUrl: string | null;
    inventoryUpdated: boolean;
    previousQuantity: number | null;
    newQuantity: number | null;
  },
  binCode: string,
  status: BinAuditOutcomeStatus,
): BinAuditResult {
  return {
    captureMode: isSimulationEvidenceUrl(audit.evidenceUrl) ? "SIMULATION" : "PROD",
    binAuditId: audit.id,
    binCode,
    status,
    expectedQuantity: audit.expectedQuantity,
    observedQuantity: audit.observedQuantity,
    confidence: audit.countConfidence,
    confidencePercent: audit.countConfidence === null ? null : confidencePercent(audit.countConfidence),
    inventoryUpdated: audit.inventoryUpdated,
    previousQuantity: audit.previousQuantity,
    newQuantity: audit.newQuantity,
    evidenceUrl: audit.evidenceUrl,
  };
}

/**
 * A human's LATER decision (from the Warehouse dashboard's trailing audit
 * card, not the live capture dialog) on a REVIEW_REQUIRED observation that
 * was already left for review — either because it came from a trusted/idle
 * run with no one to answer it live, or because a live session was
 * abandoned before the operator decided. Apply the observed count, or
 * dismiss it and leave the recorded quantity exactly as it was.
 *
 * PURELY A DATABASE ACTION. The physical audit already fully happened — the
 * gantry already returned this bin to its shelf slot, and nothing here moves
 * it again.
 */
export async function confirmBinAuditObservation(
  binAuditId: string,
  decision: ConfirmBinAuditDecision,
): Promise<BinAuditResult> {
  const audit = await prisma.binAudit.findUnique({
    where: { id: binAuditId },
    include: { bin: true, expectedPart: true },
  });
  if (!audit) throw new Error("bin_audit_not_found");
  if (audit.status !== "REVIEW_REQUIRED") {
    throw new Error(`bin_audit_not_pending_confirmation:${audit.status}`);
  }

  if (decision === "DISMISS") {
    const updated = await prisma.binAudit.update({
      where: { id: audit.id },
      data: { status: "DISMISSED", completedAt: new Date() },
    });
    return toConfirmationResult(updated, audit.bin.code, "DISMISSED");
  }

  if (!audit.expectedPartId || !audit.expectedPart || audit.observedQuantity === null) {
    throw new Error("bin_audit_not_confirmable");
  }
  if (isSimulationEvidenceUrl(audit.evidenceUrl)) {
    throw new Error("simulation_audit_not_applicable");
  }
  // Defense in depth: only a REVIEW_DECREASE-style rejection means "this
  // count is trustworthy, just lower than what's on file" — every other
  // reason (low confidence, foreign object, over capacity) means the count
  // itself can't be trusted, so applying it would defeat why it was
  // flagged. The UI already withholds the Apply button for those, but this
  // never assumes a client actually did.
  if (audit.errorCode !== "audit_pending_confirmation") {
    throw new Error("bin_audit_not_confirmable");
  }
  const part = audit.expectedPart;
  const bin = audit.bin;

  const current = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: part.id, binId: bin.id } },
  });
  const currentQuantity = current?.quantity ?? 0;

  if (currentQuantity === audit.observedQuantity) {
    const updated = await prisma.binAudit.update({
      where: { id: audit.id },
      data: { status: "CONFIRMED", inventoryUpdated: false, completedAt: new Date() },
    });
    return toConfirmationResult(updated, bin.code, "CONFIRMED");
  }

  await setInventoryQuantity({ sku: part.sku, binCode: bin.code, quantity: audit.observedQuantity });

  const updated = await prisma.binAudit.update({
    where: { id: audit.id },
    data: {
      status: "CONFIRMED",
      inventoryUpdated: true,
      previousQuantity: currentQuantity,
      newQuantity: audit.observedQuantity,
      completedAt: new Date(),
    },
  });
  return toConfirmationResult(updated, bin.code, "CONFIRMED");
}
