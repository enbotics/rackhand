import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db";
import { getGantryController } from "@/lib/gantry/factory";
import { countAuditImage, type AuditExpectedContext } from "@/lib/geminiAuditCount";
import { setInventoryQuantity } from "./inventory-service";
import {
  AUDIT_AUTO_RECONCILE_CONFIDENCE,
  AUDIT_CAPTURE_TIMEOUT_MS,
  confidencePercent,
  isAuditVisionResult,
  type AuditVisionResult,
  type BinAuditOutcomeStatus,
  type BinAuditResult,
} from "./audit-types";

const CAPTURE_POLL_MS = 400;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** AUDIT_CAPTURE_MODE, case-insensitive; anything other than "SIMULATION" stays PROD (live camera). */
function isAuditSimulationMode(): boolean {
  return process.env.AUDIT_CAPTURE_MODE?.trim().toUpperCase() === "SIMULATION";
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Every evidence photo this bin has ever had — a putaway verification or a past audit's capture. */
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

type CaptureWaitResult =
  | { ok: true; evidenceUrl: string; vision: AuditVisionResult }
  | { ok: false; reason: string };

/**
 * AUDIT_CAPTURE_MODE=SIMULATION stand-in for a live camera capture: no
 * physical camera opens and no browser is involved. Instead a real photo is
 * sampled — 3 at random, shuffled, one taken — and sent through the exact
 * same live Gemini call a genuine capture would use. Nothing about the
 * vision analysis is scripted or static; only the source of the image bytes
 * is swapped out.
 *
 * The pool prefers a bin's curated local demo photos (public/audit-
 * simulation/<BIN>/pool/), and falls back to this bin's own real evidence
 * history (past audits, past putaway verifications) when no such folder
 * exists.
 */
async function simulateCapture(
  bin: { id: string; code: string },
  expected: AuditExpectedContext,
): Promise<CaptureWaitResult> {
  const localPool = await findLocalSimulationPool(bin.code);
  const history = localPool.length > 0 ? localPool : await findBinEvidenceHistory(bin.id);
  if (history.length === 0) return { ok: false, reason: "audit_simulation_no_evidence" };
  const sample = shuffled(history).slice(0, 3);
  const evidenceUrl = sample[Math.floor(Math.random() * sample.length)];

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

async function waitForCapture(captureId: string): Promise<CaptureWaitResult> {
  const deadline = Date.now() + AUDIT_CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const capture = await prisma.auditCaptureRequest.findUnique({ where: { id: captureId } });
    if (!capture) return { ok: false, reason: "capture_request_missing" };
    if (capture.status === "FAILED") {
      return { ok: false, reason: capture.errorCode ?? "capture_failed" };
    }
    if (capture.status === "CAPTURED" && capture.evidenceUrl && capture.visionResultJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(capture.visionResultJson);
      } catch {
        return { ok: false, reason: "audit_vision_invalid" };
      }
      return isAuditVisionResult(parsed)
        ? { ok: true, evidenceUrl: capture.evidenceUrl, vision: parsed }
        : { ok: false, reason: "audit_vision_invalid" };
    }
    await wait(CAPTURE_POLL_MS);
  }
  await prisma.auditCaptureRequest.updateMany({
    where: { id: captureId, status: { in: ["WAITING_FOR_CAMERA", "CAPTURING"] } },
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

  let captured: CaptureWaitResult;
  try {
    if (isAuditSimulationMode()) {
      // No AuditCaptureRequest row is ever created for this run — the
      // Warehouse Command Center's camera polls for exactly that row to
      // decide whether to open its capture modal, so skipping it entirely is
      // what keeps simulation invisible to the browser.
      captured = await simulateCapture(bin, {
        binCode: bin.code,
        sku: audit.expectedPart?.sku ?? null,
        canonicalName: audit.expectedPart?.canonicalName ?? null,
        dimensions: audit.expectedPart
          ? {
              lengthMM: audit.expectedPart.lengthMM,
              widthMM: audit.expectedPart.widthMM,
              heightMM: audit.expectedPart.heightMM,
            }
          : null,
      });
    } else {
      const capture = await prisma.auditCaptureRequest.create({
        data: {
          binAuditId: audit.id,
          status: "WAITING_FOR_CAMERA",
          expiresAt: new Date(Date.now() + AUDIT_CAPTURE_TIMEOUT_MS),
        },
      });
      captured = await waitForCapture(capture.id);
    }
  } catch (error) {
    console.error(`[inventory-audit] capture handshake failed bin=${bin.code}`, error);
    captured = { ok: false, reason: "capture_handshake_failed" };
  }

  // Returning the bin is mandatory even when capture or vision analysis fails.
  const returned = await gantry.returnBinFromAudit({ binCode: bin.code }).catch(() => null);
  if (!returned || returned.status !== "COMPLETED") {
    // AUDITING deliberately remains set: physical location is uncertain.
    return failAudit(audit.id, bin.code, audit.expectedQuantity, "audit_return_failed");
  }

  if (!captured.ok) {
    await prisma.bin.updateMany({ where: { id: bin.id, status: "AUDITING" }, data: { status: originalStatus } });
    return failAudit(audit.id, bin.code, audit.expectedQuantity, captured.reason);
  }

  const { vision, evidenceUrl } = captured;
  const observed = vision.observedCount;
  const safeObservation =
    vision.countable &&
    observed !== null &&
    vision.countConfidence > AUDIT_AUTO_RECONCILE_CONFIDENCE &&
    !vision.foreignObjectSuspected &&
    (vision.occlusion === "NONE" || vision.occlusion === "LOW") &&
    observed <= bin.capacity &&
    (observed === 0 || (audit.expectedPartId !== null && vision.expectedPartPresent));

  let status: BinAuditResult["status"] = "REVIEW_REQUIRED";
  // executeBinAudit itself never writes to Inventory any more — every write
  // now goes through confirmBinAuditObservation, so this stays false here.
  const inventoryUpdated = false;
  let newQuantity: number | null = null;
  let reason: string | undefined;

  if (safeObservation && audit.expectedPartId) {
    // A confident, safe count. This used to write straight to Inventory
    // (AUTO_RECONCILED) whenever it differed from what was on file — now
    // every such write waits for a human's explicit apply via
    // confirmBinAuditObservation, so the bin is simply released back to
    // circulation with nothing changed yet.
    const released = await prisma.bin.updateMany({
      where: { id: bin.id, status: "AUDITING" },
      data: { status: originalStatus },
    });
    if (released.count === 1) {
      if (observed === audit.expectedQuantity) {
        // Nothing to change — there is no write for a human to confirm.
        status = "VERIFIED";
        newQuantity = observed;
      } else {
        reason = "audit_pending_confirmation";
      }
    } else {
      reason = "audit_lock_lost";
    }
  } else if (safeObservation && !audit.expectedPartId && observed === 0) {
    const released = await prisma.bin.updateMany({
      where: { id: bin.id, status: "AUDITING" },
      data: { status: "AVAILABLE" },
    });
    if (released.count === 1) {
      status = "VERIFIED";
      newQuantity = 0;
    } else {
      reason = "audit_lock_lost";
    }
  } else {
    reason = !vision.countable
      ? "audit_count_uncertain"
      : vision.foreignObjectSuspected
        ? "foreign_object_suspected"
        : vision.countConfidence <= AUDIT_AUTO_RECONCILE_CONFIDENCE
          ? "audit_confidence_not_above_80_percent"
          : !audit.expectedPartId && (observed ?? 0) > 0
            ? "physical_stock_without_record"
            : "audit_observation_unsafe";
    const released = await prisma.bin.updateMany({
      where: { id: bin.id, status: "AUDITING" },
      data: { status: reason === "physical_stock_without_record" ? "DISABLED" : originalStatus },
    });
    if (released.count !== 1) reason = "audit_lock_lost";
  }

  if (reason && status !== "REVIEW_REQUIRED") status = "REVIEW_REQUIRED";
  const completedAt = new Date();
  await prisma.binAudit.update({
    where: { id: audit.id },
    data: {
      status,
      observedQuantity: observed,
      countConfidence: vision.countConfidence,
      countable: vision.countable,
      expectedPartPresent: vision.expectedPartPresent,
      foreignObjectSuspected: vision.foreignObjectSuspected,
      occlusion: vision.occlusion,
      notes: vision.notes,
      evidenceUrl,
      inventoryUpdated,
      previousQuantity: audit.expectedQuantity,
      newQuantity,
      errorCode: reason,
      errorMessage: reason,
      completedAt,
    },
  });

  return {
    binAuditId: audit.id,
    binCode: bin.code,
    status,
    expectedQuantity: audit.expectedQuantity,
    observedQuantity: observed,
    confidence: vision.countConfidence,
    confidencePercent: confidencePercent(vision.countConfidence),
    inventoryUpdated,
    previousQuantity: audit.expectedQuantity,
    newQuantity,
    evidenceUrl,
    ...(reason ? { reason } : {}),
  };
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
 * A human's decision on a REVIEW_REQUIRED observation: apply its observed
 * count to inventory, or dismiss it and leave the recorded quantity exactly
 * as it was.
 *
 * PURELY A DATABASE ACTION. The physical audit already fully happened — the
 * gantry already returned this bin to its shelf slot, and nothing here moves
 * it again. This only decides whether the warehouse's own database should
 * now believe the camera's count — no observation is ever written
 * automatically, confident or not.
 *
 * Scope is deliberately narrow, matching what the confirmation card can
 * actually show a human: only a REVIEW_REQUIRED audit with a known expected
 * part and a countable observation is confirmable. A "physical stock found
 * with no catalog record at all" case has no part to attribute stock to and
 * stays out of scope — that already has its own resolution path through
 * ordinary bin management, not this one.
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
  const part = audit.expectedPart;
  const bin = audit.bin;

  const current = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: part.id, binId: bin.id } },
  });
  const currentQuantity = current?.quantity ?? 0;

  // Already matches what is on file — nothing to write, just close the loop
  // so the confirmation card stops asking.
  if (currentQuantity === audit.observedQuantity) {
    const updated = await prisma.binAudit.update({
      where: { id: audit.id },
      data: { status: "CONFIRMED", inventoryUpdated: false, completedAt: new Date() },
    });
    return toConfirmationResult(updated, bin.code, "CONFIRMED");
  }

  // The same deterministic write path a manual bin-detail quantity edit
  // uses — same capacity/DISABLED/AUDITING guards, same ADJUSTMENT movement
  // audit trail, same bin-status (OCCUPIED/AVAILABLE) transition. A bin that
  // changed state since the flagged audit (checked out, disabled, deleted)
  // refuses here exactly as it would for that manual edit, and this
  // BinAudit stays REVIEW_REQUIRED rather than being marked CONFIRMED for a
  // write that did not actually happen.
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
