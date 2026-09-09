import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db";
import { getGantryController } from "@/lib/gantry/factory";
import { countAuditImage, type AuditExpectedContext } from "@/lib/geminiAuditCount";
import { setInventoryQuantity } from "./inventory-service";
import { getAuditCaptureMode, isSimulationEligibleBin } from "./audit-capture-mode";
import { scheduleSimulationRevert } from "./simulation-revert";
import {
  AUDIT_CAPTURE_CONFIDENCE_THRESHOLD,
  type AuditCaptureDecision,
  type AuditCaptureOutcome,
} from "./audit-capture-types";
import {
  AUDIT_CAPTURE_TIMEOUT_MS,
  confidencePercent,
  type AuditVisionResult,
  type BinAuditOutcomeStatus,
  type BinAuditResult,
} from "./audit-types";

const CAPTURE_POLL_MS = 400;
/** ACCEPTED terminal statuses executeBinAudit's poll is waiting for. */
const TERMINAL_CAPTURE_STATUSES = ["ACCEPTED", "FAILED"];
/**
 * Statuses a legitimate retry may reset from. PENDING_ACK is deliberately
 * excluded — its write already happened (VERIFIED/AUTO_RECONCILED), so
 * resetting it to WAITING_FOR_CAMERA would leave the BinAudit finalized
 * while the capture row went back to waiting for a photo nobody needs.
 */
const RETRYABLE_CAPTURE_STATUSES = ["REVIEW_DECREASE", "RETRY_REQUIRED"];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuditSimulationMode(): boolean {
  return getAuditCaptureMode() === "SIMULATION";
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Every evidence photo this bin has ever had — a putaway verification or a past audit's capture. Used only for the simulation demo pool, where variety matters more than "was it accepted." */
async function findBinEvidenceHistory(binId: string): Promise<string[]> {
  const [putaways, audits] = await Promise.all([
    prisma.movement.findMany({
      where: { destinationBinId: binId, verificationImageUrl: { not: null } },
      select: { verificationImageUrl: true },
    }),
    prisma.binAudit.findMany({
      where: { binId, evidenceUrl: { not: null } },
      select: { evidenceUrl: true },
    }),
  ]);
  const urls = [
    ...putaways.map((row) => row.verificationImageUrl),
    ...audits.map((row) => row.evidenceUrl),
  ].filter((url): url is string => url !== null);
  return [...new Set(urls)];
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

const LOCAL_SIMULATION_ROOT = path.join(process.cwd(), "public", "audit-simulation");

/**
 * A bin-specific folder of demo photos checked straight into the repo
 * (public/audit-simulation/<BIN_CODE>/pool/*) — curated simulation evidence
 * for a bin that has no real audit history yet. These ship with the app like
 * any other file under /public, so no Supabase Storage upload is needed:
 * their public URL path IS their evidenceUrl, on Vercel exactly as in dev.
 */
async function findLocalSimulationPool(binCode: string): Promise<string[]> {
  const dir = path.join(LOCAL_SIMULATION_ROOT, binCode, "pool");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((file) => /\.(jpe?g|png)$/i.test(file))
    .map((file) => `/audit-simulation/${binCode}/pool/${file}`);
}

/** evidenceUrl is either a real Supabase URL or a local /audit-simulation/... path. */
async function loadImageBytes(evidenceUrl: string): Promise<Buffer> {
  if (evidenceUrl.startsWith("/")) {
    return readFile(path.join(process.cwd(), "public", evidenceUrl));
  }
  const response = await fetch(evidenceUrl);
  if (!response.ok) throw new Error(`status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function failAudit(
  binAuditId: string,
  binCode: string,
  expectedQuantity: number,
  reason: string,
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
 * Same decision policy for a real capture and a simulated one, and the
 * one place foreign objects, confidence, occlusion, identity, capacity and
 * the expected/observed comparison are actually weighed. Gemini itself never
 * decides anything — it only reports what it saw; this function is the only
 * thing allowed to turn that observation into a database-changing decision.
 */
export function classifyAuditVision(
  vision: AuditVisionResult,
  expected: { quantity: number; partId: string | null; capacity: number },
): AuditCaptureOutcome | "UNEXPECTED_STOCK" {
  const observed = vision.observedCount;
  const foreignObjects = vision.foreignObjects ?? [];
  if (vision.foreignObjectSuspected || foreignObjects.length > 0) return "FOREIGN_OBJECTS";

  const uncertain =
    !vision.countable ||
    observed === null ||
    vision.countConfidence <= AUDIT_CAPTURE_CONFIDENCE_THRESHOLD ||
    (vision.occlusion !== "NONE" && vision.occlusion !== "LOW") ||
    (observed > 0 && expected.partId !== null && !vision.expectedPartPresent);
  if (uncertain) return "LOW_CONFIDENCE";

  if (observed! > expected.capacity) return "CAPACITY_EXCEEDED";
  if (expected.partId === null) return observed! > 0 ? "UNEXPECTED_STOCK" : "VERIFIED";
  if (observed! === expected.quantity) return "VERIFIED";
  return observed! > expected.quantity ? "AUTO_RECONCILED" : "REVIEW_DECREASE";
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
  return {
    countable: capture.countable ?? true,
    observedCount: capture.observedQuantity,
    countConfidence: capture.countConfidence ?? 0,
    expectedPartPresent: capture.expectedPartPresent ?? true,
    foreignObjectSuspected: capture.foreignObjectSuspected ?? false,
    foreignObjects: capture.foreignObjectsJson ? (JSON.parse(capture.foreignObjectsJson) as string[]) : [],
    occlusion: (capture.occlusion as AuditVisionResult["occlusion"]) ?? "NONE",
    notes: capture.notes ?? "",
  };
}

/**
 * AUDIT_CAPTURE_MODE=SIMULATION stand-in for a live camera capture: no
 * physical camera opens and no browser is involved. Instead a real photo is
 * sampled at random from the bin's demo pool and sent through the exact
 * same live Gemini call a genuine capture would use. Nothing about the
 * vision analysis is scripted or static; only the source of the image bytes
 * is swapped out. No operator is present to retry or confirm anything, so
 * simulation always resolves in one shot through the same classify/finalize
 * path a real capture's automatic outcomes use.
 */
async function simulateCapture(
  bin: { id: string; code: string },
  expected: AuditExpectedContext,
): Promise<{ ok: true; evidenceUrl: string; vision: AuditVisionResult } | { ok: false; reason: string }> {
  const localPool = await findLocalSimulationPool(bin.code);
  const history = localPool.length > 0 ? localPool : await findBinEvidenceHistory(bin.id);
  if (history.length === 0) return { ok: false, reason: "audit_simulation_no_evidence" };
  const evidenceUrl = shuffled(history)[0];

  let imageBuffer: Buffer;
  try {
    imageBuffer = await loadImageBytes(evidenceUrl);
  } catch (error) {
    console.error(`[inventory-audit] simulation evidence fetch failed bin=${bin.code}`, error);
    return { ok: false, reason: "audit_simulation_fetch_failed" };
  }

  const vision = await countAuditImage(imageBuffer, expected);
  return { ok: true, evidenceUrl, vision };
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
  const deadline = Date.now() + AUDIT_CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const capture = await prisma.auditCaptureRequest.findUnique({ where: { id: captureId } });
    if (!capture) return { ok: false, reason: "capture_request_missing" };
    if (capture.status === "FAILED") return { ok: false, reason: capture.errorCode ?? "capture_failed" };
    if (capture.status === "ACCEPTED" && capture.evidenceUrl) {
      return { ok: true, finalized: true, evidenceUrl: capture.evidenceUrl, vision: visionFromCaptureRow(capture) };
    }
    // A trusted/idle run has no one to click anything — not the dismissal
    // that would turn PENDING_ACK into ACCEPTED, and not an answer to a
    // REVIEW_DECREASE or RETRY_REQUIRED prompt. Waiting for either would be
    // an indefinite hang, so the very first analysis is final either way.
    if (isTrusted && capture.status === "PENDING_ACK" && capture.evidenceUrl) {
      // The write already happened when this was classified — only the
      // administrative "operator dismissed it" flip is missing, and there is
      // no operator, so this run performs that flip on its own behalf.
      await prisma.auditCaptureRequest.updateMany({
        where: { id: captureId, status: "PENDING_ACK" },
        data: { status: "ACCEPTED" },
      });
      return { ok: true, finalized: true, evidenceUrl: capture.evidenceUrl, vision: visionFromCaptureRow(capture) };
    }
    if (isTrusted && (capture.status === "REVIEW_DECREASE" || capture.status === "RETRY_REQUIRED")) {
      return { ok: true, finalized: false, evidenceUrl: capture.evidenceUrl ?? "", vision: visionFromCaptureRow(capture) };
    }
    await wait(CAPTURE_POLL_MS);
  }
  await prisma.auditCaptureRequest.updateMany({
    where: { id: captureId, status: { notIn: TERMINAL_CAPTURE_STATUSES } },
    data: { status: "FAILED", errorCode: "capture_station_unavailable" },
  });
  return { ok: false, reason: "capture_station_unavailable" };
}

/** Audits exactly one bin. The caller guarantees sequential execution. */
export async function executeBinAudit(binAuditId: string): Promise<BinAuditResult> {
  const audit = await prisma.binAudit.findUnique({
    where: { id: binAuditId },
    include: { bin: true, expectedPart: true, auditRun: true },
  });
  if (!audit) throw new Error("bin_audit_not_found");
  const { bin } = audit;
  const originalStatus = bin.status;
  const isTrusted = audit.auditRun.trigger === "TRUSTED_INTERNAL";
  if (!["AVAILABLE", "OCCUPIED"].includes(originalStatus)) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "bin_audit_conflict");
  }

  const gantry = getGantryController();
  const gantryStatus = await gantry.getStatus();
  if (gantryStatus.state !== "IDLE" || gantryStatus.activeOperationId) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "gantry_busy");
  }

  const claimed = await prisma.bin.updateMany({
    where: { id: bin.id, status: originalStatus },
    data: { status: "AUDITING" },
  });
  if (claimed.count !== 1) {
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "bin_audit_conflict");
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
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_move_failed");
  }

  // Physical safety: the bin stays at SCAN_STATION for the ENTIRE capture,
  // retry and confirmation dance below — it is only returned once a
  // terminal result exists (accepted, or this run has genuinely given up).
  const simulated = isAuditSimulationMode() && isSimulationEligibleBin(bin.code);
  let captured: CaptureWaitResult;
  try {
    if (simulated) {
      // No AuditCaptureRequest row is ever created for this run — the
      // Warehouse Command Center's camera polls for exactly that row to
      // decide whether to open its capture popup, so skipping it entirely is
      // what keeps simulation invisible to the browser. There is no operator
      // to retry or confirm, so a simulated capture is finalized in one shot
      // by executeBinAudit itself rather than the capture route.
      const expected: AuditExpectedContext = {
        binCode: bin.code,
        sku: audit.expectedPart?.sku ?? null,
        canonicalName: audit.expectedPart?.canonicalName ?? null,
        dimensions: audit.expectedPart
          ? { lengthMM: audit.expectedPart.lengthMM, widthMM: audit.expectedPart.widthMM, heightMM: audit.expectedPart.heightMM }
          : null,
      };
      const result = await simulateCapture(bin, expected);
      captured = result.ok ? { ok: true, finalized: false, evidenceUrl: result.evidenceUrl, vision: result.vision } : result;
    } else {
      const previousImageUrl = await findLatestAcceptedSnapshot(bin.id);
      const capture = await prisma.auditCaptureRequest.create({
        data: {
          binAuditId: audit.id,
          status: "WAITING_FOR_CAMERA",
          expectedQuantity: audit.expectedQuantity,
          previousImageUrl,
          expiresAt: new Date(Date.now() + AUDIT_CAPTURE_TIMEOUT_MS),
        },
      });
      captured = await waitForTerminalCapture(capture.id, isTrusted);
    }
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
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_return_failed");
  }
  if (returned.status === "COMPLETED" && captured.ok && captured.finalized) {
    // An accepted result means nothing is carried on the arm — safe to park.
    await gantry.home().catch((error) => {
      console.error(`[inventory-audit] post-audit home failed bin=${bin.code}`, error);
    });
  }

  if (!captured.ok) {
    await prisma.bin.updateMany({ where: { id: bin.id, status: "AUDITING" }, data: { status: originalStatus } });
    return failAudit(audit.id, bin.code, audit.expectedQuantity, captured.reason);
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
    // A simulated capture is never a real physical count — undo the write a
    // few seconds after it happened rather than let demo data corrupt real
    // stock. A real trusted/idle audit that genuinely reconciled is left
    // exactly as it is; only `simulated` reaches this with a fake write.
    if (simulated && applied.inventoryUpdated && audit.expectedPartId) {
      scheduleSimulationRevert({
        partId: audit.expectedPartId,
        binId: bin.id,
        previousQuantity: audit.expectedQuantity,
        source: "audit",
      });
    }
    return {
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

  // The operator's decision (auto-applied or explicitly confirmed) already
  // finalized Inventory and this BinAudit row via the capture/decision
  // route — read that authoritative result back rather than recomputing it.
  const finalAudit = await prisma.binAudit.findUniqueOrThrow({ where: { id: audit.id } });
  return {
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
 * Classifies one freshly captured audit frame and, for a safe automatic
 * outcome, finalizes it immediately — called by the captures/[id] route.
 * REVIEW_DECREASE and RETRY_REQUIRED persist the analysis and stop there;
 * only an explicit decision (confirmAuditCaptureDecision) can move them
 * forward.
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
}): Promise<{ outcome: AuditCaptureOutcome | "UNEXPECTED_STOCK"; status: string }> {
  const outcome = classifyAuditVision(input.vision, {
    quantity: input.expectedQuantity,
    partId: input.expectedPartId,
    capacity: input.capacity,
  });
  const foreignObjectsJson = JSON.stringify(foreignObjectNames(input.vision));
  const capturedAt = new Date();

  if (outcome === "REVIEW_DECREASE" || outcome === "LOW_CONFIDENCE" || outcome === "CAPACITY_EXCEEDED" || outcome === "FOREIGN_OBJECTS") {
    const status = outcome === "REVIEW_DECREASE" ? "REVIEW_DECREASE" : "RETRY_REQUIRED";
    await prisma.auditCaptureRequest.update({
      where: { id: input.captureId },
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
      },
    });
    return { outcome, status };
  }

  // VERIFIED, AUTO_RECONCILED, UNEXPECTED_STOCK — no human decision governs
  // WHETHER this writes, so finalize now.
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
  // UNEXPECTED_STOCK has no confirmable comparison — there is no part on
  // file to attribute the count to, so there is nothing left to dismiss or
  // retry either. It goes straight to ACCEPTED so the bin can be returned,
  // and the dialog shows the plain fallback screen rather than offering a
  // "Retry" that would reopen a camera for an audit already closed out.
  // VERIFIED/AUTO_RECONCILED still need the operator to actively dismiss
  // the comparison before the bin is considered safe to move (PENDING_ACK),
  // even though the write itself already happened.
  const status = outcome === "UNEXPECTED_STOCK" ? "ACCEPTED" : "PENDING_ACK";
  await prisma.auditCaptureRequest.update({
    where: { id: input.captureId },
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
    },
  });
  return { outcome, status };
}

/**
 * A human's decision on a pending audit capture: ACCEPT either dismisses an
 * already-applied automatic result (PENDING_ACK) so the bin can be returned,
 * or explicitly confirms a REVIEW_DECREASE (which writes Inventory only
 * now). RETRY resets the same row for a fresh photo — reused, never
 * duplicated — and renews its expiry so a legitimate retry is never cut off
 * mid-attempt.
 */
export async function decideAuditCapture(captureId: string, decision: AuditCaptureDecision): Promise<void> {
  const capture = await prisma.auditCaptureRequest.findUnique({
    where: { id: captureId },
    include: { binAudit: { include: { bin: true, expectedPart: true } } },
  });
  if (!capture) throw new Error("audit_capture_not_found");

  if (decision === "RETRY") {
    if (!RETRYABLE_CAPTURE_STATUSES.includes(capture.status)) throw new Error("audit_capture_not_retryable");
    const reset = await prisma.auditCaptureRequest.updateMany({
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
        attempt: { increment: 1 },
        expiresAt: new Date(Date.now() + AUDIT_CAPTURE_TIMEOUT_MS),
      },
    });
    if (reset.count !== 1) throw new Error("audit_capture_not_retryable");
    return;
  }

  // ACCEPT
  if (capture.status === "PENDING_ACK") {
    const accepted = await prisma.auditCaptureRequest.updateMany({
      where: { id: captureId, status: "PENDING_ACK" },
      data: { status: "ACCEPTED" },
    });
    if (accepted.count !== 1) throw new Error("audit_capture_not_pending");
    return;
  }

  if (capture.status !== "REVIEW_DECREASE") throw new Error("audit_capture_not_pending");
  if (capture.observedQuantity === null) throw new Error("audit_capture_not_confirmable");

  // The operator explicitly accepted the lower count, so this records
  // CONFIRMED — never a bare REVIEW_REQUIRED, which is reserved for a
  // give-up nobody actually decided.
  const { binAudit } = capture;
  if (!binAudit.expectedPartId || !binAudit.expectedPart) throw new Error("audit_capture_not_confirmable");
  const current = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: binAudit.expectedPartId, binId: binAudit.binId } },
  });
  const currentQuantity = current?.quantity ?? 0;

  if (currentQuantity !== capture.observedQuantity) {
    await setInventoryQuantity({
      sku: binAudit.expectedPart.sku,
      binCode: binAudit.bin.code,
      quantity: capture.observedQuantity,
    }).catch(() => {
      // Bin state changed since the flagged audit (checked out, disabled,
      // deleted) — leave BinAudit as-is; the operator sees the failure below.
      throw new Error("audit_capture_stale_bin");
    });
  }
  await prisma.binAudit.update({
    where: { id: binAudit.id },
    data: {
      status: "CONFIRMED",
      inventoryUpdated: currentQuantity !== capture.observedQuantity,
      previousQuantity: currentQuantity,
      newQuantity: capture.observedQuantity,
      completedAt: new Date(),
    },
  });
  const accepted = await prisma.auditCaptureRequest.updateMany({
    where: { id: captureId, status: "REVIEW_DECREASE" },
    data: { status: "ACCEPTED" },
  });
  if (accepted.count !== 1) throw new Error("audit_capture_not_pending");
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
