import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  captureProcessingHeartbeatMilliseconds,
  createCaptureJob,
} from "@/lib/camera/capture-job-service";
import { countAuditImage, type AuditExpectedContext } from "@/lib/geminiAuditCount";
import { getGantryController } from "@/lib/gantry/factory";
import { prisma } from "./db";
import { confidencePercent, type AuditVisionResult } from "./audit-types";
import {
  getAuditCaptureMode,
  isOutOfSimulationScope,
  isSimulationEligibleBin,
  SimulationScopeError,
  waitOutSimulatedCaptureDuration,
} from "./audit-capture-mode";
import { captureProcessingDeadline } from "./capture-deadlines";
import { scheduleSimulationRevert } from "./simulation-revert";
import {
  PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
  type PutawayCaptureDecision,
  type PutawayCaptureOutcome,
  type PutawayCaptureView,
} from "./putaway-capture-types";

export const PUTAWAY_CAPTURE_MARKERS = ["VERIFY_PUTAWAY", "VERIFY_RETURN"];
const ACTIONABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE"];
const RETRYABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE", "RETRY_REQUIRED"];

function isPutawaySimulationMode(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && isSimulationEligibleBin(binCode);
}

/** Shared real/simulated putaway vision policy. */
function classifyPutawayVision(
  vision: AuditVisionResult,
  expectedQuantity: number,
  capacity: number,
): { outcome: PutawayCaptureOutcome; foreignObjects: string[] } {
  const observed = vision.observedCount;
  const foreignObjects = vision.foreignObjects ?? [];
  const hasForeignObjects = vision.foreignObjectSuspected || foreignObjects.length > 0;
  const confident = vision.countable
    && observed !== null
    && vision.countConfidence > PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD
    && ["NONE", "LOW"].includes(vision.occlusion)
    && (observed === 0 || vision.expectedPartPresent);

  if (hasForeignObjects) return { outcome: "FOREIGN_OBJECTS", foreignObjects };
  if (!confident) return { outcome: "LOW_CONFIDENCE", foreignObjects };
  if (observed! > capacity) return { outcome: "CAPACITY_EXCEEDED", foreignObjects };
  if (observed! < expectedQuantity) return { outcome: "REVIEW_DECREASE", foreignObjects };
  return { outcome: observed! > expectedQuantity ? "INCREASED" : "READY", foreignObjects };
}

const SIMULATION_ROOT = path.join(process.cwd(), "public", "audit-simulation");

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadSimulationImage(binCode: string): Promise<{ url: string; bytes: Buffer } | null> {
  const dir = path.join(SIMULATION_ROOT, binCode, "pool");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => /\.(jpe?g|png)$/i.test(file));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const file = shuffled(files)[0];
  const url = `/audit-simulation/${binCode}/pool/${file}`;
  const bytes = await readFile(path.join(SIMULATION_ROOT, binCode, "pool", file));
  return { url, bytes };
}

/**
 * AUDIT_CAPTURE_MODE=SIMULATION stand-in for the real camera step, for the
 * two bins actually set up for it. No popup opens; a real photo is sampled
 * from that bin's demo pool and sent through the exact same live Gemini
 * call a genuine verification would use — only the source of the image
 * bytes is fake. There is no operator to accept or retry, so every outcome
 * (including a decrease that would normally need a human) auto-accepts: a
 * simulated write is undone a few seconds later regardless (see
 * scheduleSimulationRevert), so there is nothing unsafe about letting it
 * through without a person watching.
 */
async function simulatePutawayVerification(input: {
  movementId: string;
  binCode: string;
  binId: string;
  partId: string;
  expectedQuantity: number;
  previousQuantity: number;
  expected: AuditExpectedContext;
}): Promise<{ imageUrl: string; capturedAt: Date; quantity: number } | null> {
  const sample = await loadSimulationImage(input.binCode);
  if (!sample) return null;
  const vision = await countAuditImage(sample.bytes, input.expected);
  // Every outcome auto-accepts here regardless — there is no operator to
  // hand a retry/confirm decision to, and a simulated write is undone a few
  // seconds later either way (see scheduleSimulationRevert below), so
  // nothing unsafe comes from letting even a low-confidence read through.
  const observed = vision.observedCount ?? input.expectedQuantity;
  const capturedAt = new Date();

  await prisma.movement.update({
    where: { id: input.movementId },
    data: { newQuantity: observed, imageUrl: sample.url, verificationImageUrl: sample.url, verificationCapturedAt: capturedAt },
  });

  if (observed !== input.previousQuantity) {
    scheduleSimulationRevert({
      partId: input.partId,
      binId: input.binId,
      previousQuantity: input.previousQuantity,
      source: "putaway",
    });
  }
  return { imageUrl: sample.url, capturedAt, quantity: observed };
}

function parseForeignObjects(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function captureView(input: {
  id: string;
  status: string;
  expectedQuantity: number;
  observedQuantity: number | null;
  countConfidence: number | null;
  previousImageUrl: string | null;
  evidenceUrl: string | null;
  foreignObjectsJson: string | null;
  notes: string | null;
  movement: { destinationBin: { code: string } | null };
}, outcome: PutawayCaptureOutcome): PutawayCaptureView {
  return {
    captureId: input.id,
    binCode: input.movement.destinationBin?.code ?? "bin",
    status: input.status,
    outcome,
    expectedQuantity: input.expectedQuantity,
    observedQuantity: input.observedQuantity,
    confidencePercent: input.countConfidence === null ? null : confidencePercent(input.countConfidence),
    previousImageUrl: input.previousImageUrl,
    currentImageUrl: input.evidenceUrl,
    foreignObjects: parseForeignObjects(input.foreignObjectsJson),
    notes: input.notes,
  };
}

async function latestSnapshotBefore(binId: string, movementId: string): Promise<string | null> {
  const [putaway, audit] = await Promise.all([
    prisma.movement.findFirst({
      where: {
        id: { not: movementId },
        destinationBinId: binId,
        verificationImageUrl: { not: null },
        verificationCapturedAt: { not: null },
      },
      orderBy: { verificationCapturedAt: "desc" },
      select: { verificationImageUrl: true, verificationCapturedAt: true },
    }),
    prisma.binAudit.findFirst({
      where: { binId, evidenceUrl: { not: null }, capturedAt: { not: null } },
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

export async function pendingPutawayCapture() {
  const capture = await prisma.putawayCaptureRequest.findFirst({
    where: {
      status: "WAITING_FOR_CAMERA",
      movement: { status: { in: ["VALIDATED", "AWAITING_PLACEMENT"] } },
    },
    include: { movement: { include: { destinationBin: true } } },
    orderBy: { createdAt: "asc" },
  });
  return capture
    ? { captureId: capture.id, binCode: capture.movement.destinationBin?.code ?? "bin", purpose: "PUTAWAY" as const }
    : { captureId: null };
}

/** Request one physical Raspberry Pi frame for a pending putaway check. */
export async function requestPutawayCameraCapture(id: string) {
  const capture = await prisma.putawayCaptureRequest.findUnique({
    where: { id },
    include: { movement: true },
  });
  if (!capture || capture.status !== "WAITING_FOR_CAMERA") {
    throw new Error("This putaway verification is stale or no longer pending.");
  }
  if (!["VALIDATED", "AWAITING_PLACEMENT"].includes(capture.movement.status)) {
    throw new Error("This putaway is no longer waiting for verification.");
  }
  const gantry = await getGantryController().getStatus();
  if (gantry.state !== "IDLE" || gantry.activeOperationId) {
    throw new Error("Wait for the gantry to stop before requesting a photo.");
  }

  const existing = await prisma.cameraCaptureJob.findFirst({
    where: {
      purpose: "PUTAWAY_VERIFICATION",
      workflowCaptureId: id,
      status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
    },
    orderBy: { requestedAt: "desc" },
  });
  return existing ?? createCaptureJob({
    purpose: "PUTAWAY_VERIFICATION",
    workflowCaptureId: id,
    workflowAttempt: capture.attempt,
  });
}

/** Blocks the machine workflow until the Raspberry Pi capture is analyzed and accepted. */
export async function requirePutawayVerification(movementId: string, isReturn = false) {
  const movement = await prisma.movement.findUniqueOrThrow({
    where: { id: movementId },
    include: { destinationBin: true, part: true },
  });
  if (!movement.destinationBin) throw new Error("Putaway destination is missing.");
  const expectedQuantity = movement.newQuantity ?? movement.previousQuantity ?? movement.quantity;

  // Refuse before creating any capture request: Simulation mode must never
  // silently fall through to a real capture on a bin it doesn't cover.
  if (isOutOfSimulationScope(movement.destinationBin.code)) {
    throw new SimulationScopeError(movement.destinationBin.code);
  }

  if (isPutawaySimulationMode(movement.destinationBin.code)) {
    // No PutawayCaptureRequest row is ever created for this run — the
    // Warehouse Command Center's Realtime capture stream watches for that row to
    // decide whether to open its popup, so skipping it entirely keeps
    // simulation invisible to the browser, same as audit simulation does.
    const startedAt = Date.now();
    const simulated = await simulatePutawayVerification({
      movementId,
      binCode: movement.destinationBin.code,
      binId: movement.destinationBin.id,
      partId: movement.partId,
      expectedQuantity,
      previousQuantity: movement.previousQuantity ?? expectedQuantity,
      expected: {
        binCode: movement.destinationBin.code,
        sku: movement.part.sku,
        canonicalName: movement.part.canonicalName,
        dimensions: { lengthMM: movement.part.lengthMM, widthMM: movement.part.widthMM, heightMM: movement.part.heightMM },
      },
    });
    if (simulated) {
      await waitOutSimulatedCaptureDuration(startedAt);
      return simulated;
    }
    // No demo pool for this bin (images not added yet) — fall through to
    // the real camera path below rather than failing the whole putaway.
  }

  const request = await prisma.putawayCaptureRequest.create({
    data: {
      movementId,
      expectedQuantity,
      previousImageUrl: await latestSnapshotBefore(movement.destinationBin.id, movementId),
      expiresAt: null,
    },
  });
  await prisma.movement.update({
    where: { id: movementId },
    data: { destinationLocation: isReturn ? "VERIFY_RETURN" : "VERIFY_PUTAWAY" },
  });

  while (true) {
    const current = await prisma.putawayCaptureRequest.findUniqueOrThrow({ where: { id: request.id } });
    if (current.status === "FAILED") throw new Error("Putaway verification failed.");
    if (current.status === "ACCEPTED" && current.evidenceUrl && current.capturedAt && current.observedQuantity !== null) {
      return { imageUrl: current.evidenceUrl, capturedAt: current.capturedAt, quantity: current.observedQuantity };
    }

    // Only CAPTURING owns a lease. Human capture/review states intentionally
    // wait until an explicit decision or long-stop recovery.
    const now = new Date();
    if (current.status === "CAPTURING" && current.expiresAt
      && now.getTime() >= current.expiresAt.getTime()) {
      const expired = await prisma.putawayCaptureRequest.updateMany({
        where: {
          id: request.id,
          status: "CAPTURING",
          expiresAt: { lte: now },
        },
        data: { status: "FAILED", notes: "Camera verification timed out." },
      });
      // A concurrent upload/analysis/decision may have renewed the deadline
      // after our read. Only the process that atomically claims the expired
      // row is allowed to fail the movement.
      if (expired.count === 0) continue;
      await prisma.movement.updateMany({
        where: { id: movementId, status: { in: ["VALIDATED", "AWAITING_PLACEMENT"] } },
        data: { status: "FAILED" },
      });
      throw new Error("Camera verification timed out; the gantry did not move.");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export async function processPutawayCameraCapture(id: string, input: {
  imageBuffer: Buffer;
  evidenceUrl: string;
  imageWidth: number;
  imageHeight: number;
  capturedAt: Date;
  requestedAt: Date;
  workflowAttempt: number;
}): Promise<PutawayCaptureView> {
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0
    || !input.evidenceUrl
    || !Number.isInteger(input.imageWidth) || input.imageWidth <= 0
    || !Number.isInteger(input.imageHeight) || input.imageHeight <= 0
    || !Number.isFinite(input.capturedAt.getTime())) {
    throw new Error("A fresh Raspberry Pi frame and valid metadata are required.");
  }
  const gantry = await getGantryController().getStatus();
  if (gantry.state !== "IDLE" || gantry.activeOperationId) throw new Error("Wait for the gantry to stop before capture.");
  const claimed = await prisma.putawayCaptureRequest.updateMany({
    where: { id, status: "WAITING_FOR_CAMERA", attempt: input.workflowAttempt },
    data: {
      status: "CAPTURING",
      expiresAt: captureProcessingDeadline(),
    },
  });
  if (claimed.count !== 1) throw new Error("This capture is stale or no longer pending.");

  let imageUrl: string | null = null;
  try {
    const capture = await prisma.putawayCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { part: true, destinationBin: true } } },
    });
    const { movement } = capture;
    if (!["VALIDATED", "AWAITING_PLACEMENT"].includes(movement.status) || !movement.destinationBin
      || !PUTAWAY_CAPTURE_MARKERS.includes(movement.destinationLocation ?? "")
      || capture.attempt !== input.workflowAttempt
      || input.capturedAt.getTime() < input.requestedAt.getTime()
      || input.capturedAt.getTime() > Date.now() + 60_000) {
      throw new Error("This capture is stale or no longer pending.");
    }

    imageUrl = input.evidenceUrl;
    const part = movement.part;
    const leaseHeartbeat = setInterval(() => {
      void prisma.putawayCaptureRequest.updateMany({
        where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
        data: { expiresAt: captureProcessingDeadline() },
      }).catch(() => {});
    }, captureProcessingHeartbeatMilliseconds());
    let vision: AuditVisionResult;
    try {
      vision = await countAuditImage(input.imageBuffer, {
        binCode: movement.destinationBin.code,
        sku: part.sku,
        canonicalName: part.canonicalName,
        dimensions: { lengthMM: part.lengthMM, widthMM: part.widthMM, heightMM: part.heightMM },
      });
    } finally {
      clearInterval(leaseHeartbeat);
    }
    const processingRenewed = await prisma.putawayCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: { expiresAt: captureProcessingDeadline() },
    });
    if (processingRenewed.count !== 1) {
      throw new Error("This capture stopped being processable during image analysis.");
    }
    const observed = vision.observedCount;
    const { outcome, foreignObjects } = classifyPutawayVision(vision, capture.expectedQuantity, movement.destinationBin.capacity);
    const nextStatus = outcome === "REVIEW_DECREASE" ? "REVIEW_DECREASE"
      : outcome === "READY" || outcome === "INCREASED" ? "READY"
      : "RETRY_REQUIRED";

    const capturedAt = input.capturedAt;
    const persisted = await prisma.putawayCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: {
        status: nextStatus,
        observedQuantity: observed,
        countConfidence: vision.countConfidence,
        countable: vision.countable,
        expectedPartPresent: vision.expectedPartPresent,
        foreignObjectSuspected: outcome === "FOREIGN_OBJECTS",
        foreignObjectsJson: JSON.stringify(foreignObjects),
        occlusion: vision.occlusion,
        notes: vision.notes,
        evidenceUrl: imageUrl,
        imageWidth: input.imageWidth,
        imageHeight: input.imageHeight,
        capturedAt,
        expiresAt: null,
      },
    });
    if (persisted.count !== 1) throw new Error("This capture attempt was superseded during analysis.");
    const updated = await prisma.putawayCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { destinationBin: true } } },
    });
    return captureView(updated, outcome);
  } catch (error) {
    await prisma.putawayCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: {
        status: "RETRY_REQUIRED",
        evidenceUrl: imageUrl,
        notes: "The image could not be analyzed. Take a fresh photo and retry.",
        expiresAt: null,
      },
    });
    const failed = await prisma.putawayCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { destinationBin: true } } },
    });
    return captureView(failed, "LOW_CONFIDENCE");
  }
}

export async function decidePutawayCapture(id: string, decision: PutawayCaptureDecision) {
  if (decision === "RETRY") {
    await prisma.$transaction(async (tx) => {
      const reset = await tx.putawayCaptureRequest.updateMany({
        where: { id, status: { in: RETRYABLE_CAPTURE_STATUSES } },
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
          expiresAt: null,
        },
      });
      if (reset.count !== 1) throw new Error("This verification can no longer be retried.");
      await tx.cameraCaptureJob.updateMany({
        where: {
          workflowCaptureId: id,
          status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          errorCode: "camera_job_superseded",
          errorMessage: "A newer putaway verification attempt replaced this capture.",
          updatedAt: new Date(),
        },
      });
    });
    return { ok: true, status: "WAITING_FOR_CAMERA" as const };
  }

  const capture = await prisma.putawayCaptureRequest.findUnique({ where: { id } });
  if (!capture || !ACTIONABLE_CAPTURE_STATUSES.includes(capture.status)
    || capture.observedQuantity === null || !capture.evidenceUrl || !capture.capturedAt) {
    throw new Error("This verification cannot be accepted.");
  }
  await prisma.$transaction(async (tx) => {
    const accepted = await tx.putawayCaptureRequest.updateMany({
      where: { id, status: capture.status },
      data: { status: "ACCEPTED" },
    });
    if (accepted.count !== 1) throw new Error("This verification was already decided.");
    const movement = await tx.movement.updateMany({
      where: { id: capture.movementId, status: { in: ["VALIDATED", "AWAITING_PLACEMENT"] } },
      data: {
        newQuantity: capture.observedQuantity,
        imageUrl: capture.evidenceUrl,
        verificationImageUrl: capture.evidenceUrl,
        verificationCapturedAt: capture.capturedAt,
      },
    });
    if (movement.count !== 1) throw new Error("The putaway is no longer waiting for verification.");
  });
  return { ok: true, status: "ACCEPTED" as const };
}
