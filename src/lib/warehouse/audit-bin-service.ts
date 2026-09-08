import { prisma } from "./db";
import { getGantryController } from "@/lib/gantry/factory";
import {
  AUDIT_AUTO_RECONCILE_CONFIDENCE,
  AUDIT_CAPTURE_TIMEOUT_MS,
  confidencePercent,
  isAuditVisionResult,
  type AuditVisionResult,
  type BinAuditResult,
} from "./audit-types";

const CAPTURE_POLL_MS = 400;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const capture = await prisma.auditCaptureRequest.create({
      data: {
        binAuditId: audit.id,
        status: "WAITING_FOR_CAMERA",
        expiresAt: new Date(Date.now() + AUDIT_CAPTURE_TIMEOUT_MS),
      },
    });
    captured = await waitForCapture(capture.id);
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
  let inventoryUpdated = false;
  let newQuantity: number | null = null;
  let reason: string | undefined;

  if (safeObservation && audit.expectedPartId) {
    const nextStatus = observed! > 0 ? "OCCUPIED" : "AVAILABLE";
    await prisma.$transaction(async (tx) => {
      const current = await tx.inventory.findUnique({
        where: { partId_binId: { partId: audit.expectedPartId!, binId: bin.id } },
      });
      if (!current || current.quantity !== audit.expectedQuantity) throw new Error("audit_inventory_stale");
      if (observed === 0) await tx.inventory.delete({ where: { id: current.id } });
      else await tx.inventory.update({ where: { id: current.id }, data: { quantity: observed } });
      const released = await tx.bin.updateMany({
        where: { id: bin.id, status: "AUDITING" },
        data: { status: nextStatus },
      });
      if (released.count !== 1) throw new Error("audit_lock_lost");
    }).catch((error) => {
      reason = error instanceof Error ? error.message : "audit_reconciliation_failed";
    });
    if (!reason) {
      inventoryUpdated = observed !== audit.expectedQuantity;
      newQuantity = observed;
      status = inventoryUpdated ? "AUTO_RECONCILED" : "VERIFIED";
    } else {
      await prisma.bin.updateMany({
        where: { id: bin.id, status: "AUDITING" },
        data: { status: originalStatus },
      });
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
