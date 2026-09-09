import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { countAuditImage, type AuditExpectedContext } from "@/lib/geminiAuditCount";
import { getGantryController } from "@/lib/gantry/factory";
import { prisma } from "./db";
import { confidencePercent, type AuditVisionResult } from "./audit-types";
import { getAuditCaptureMode, isSimulationEligibleBin } from "./audit-capture-mode";
import { scheduleSimulationRevert } from "./simulation-revert";
import {
  PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
  type PutawayCaptureDecision,
  type PutawayCaptureOutcome,
  type PutawayCaptureView,
} from "./putaway-capture-types";
import { uploadPutawayPhoto } from "./storage";

export const PUTAWAY_CAPTURE_MARKERS = ["VERIFY_PUTAWAY", "VERIFY_RETURN"];
const CAPTURE_TIMEOUT_MS = 120_000;
const ACTIONABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE"];
const RETRYABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE", "RETRY_REQUIRED"];

function isPutawaySimulationMode(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && isSimulationEligibleBin(binCode);
}

/** Same decision policy verifyPutawayCapture uses, factored out so the simulated path shares it exactly rather than drifting from it. */
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
      expiresAt: { gt: new Date() },
      movement: { status: "VALIDATED" },
    },
    include: { movement: { include: { destinationBin: true } } },
    orderBy: { createdAt: "asc" },
  });
  return capture
    ? { captureId: capture.id, binCode: capture.movement.destinationBin?.code ?? "bin", purpose: "PUTAWAY" as const }
    : { captureId: null };
}

/** Blocks the machine workflow until the browser capture is analyzed and accepted. */
export async function requirePutawayVerification(movementId: string, isReturn = false) {
  const movement = await prisma.movement.findUniqueOrThrow({
    where: { id: movementId },
    include: { destinationBin: true, part: true },
  });
  if (!movement.destinationBin) throw new Error("Putaway destination is missing.");
  const expectedQuantity = movement.newQuantity ?? movement.previousQuantity ?? movement.quantity;

  if (isPutawaySimulationMode(movement.destinationBin.code)) {
    // No PutawayCaptureRequest row is ever created for this run — the
    // Warehouse Command Center's camera polls for exactly that row to
    // decide whether to open its popup, so skipping it entirely keeps
    // simulation invisible to the browser, same as audit simulation does.
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
    if (simulated) return simulated;
    // No demo pool for this bin (images not added yet) — fall through to
    // the real camera path below rather than failing the whole putaway.
  }

  const request = await prisma.putawayCaptureRequest.create({
    data: {
      movementId,
      expectedQuantity,
      previousImageUrl: await latestSnapshotBefore(movement.destinationBin.id, movementId),
      expiresAt: new Date(Date.now() + CAPTURE_TIMEOUT_MS),
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
    // A retry renews expiresAt on this same durable request, so always read
    // the current deadline instead of retaining the first attempt's timeout.
    if (Date.now() >= current.expiresAt.getTime()) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await prisma.$transaction([
    prisma.putawayCaptureRequest.updateMany({
      where: { id: request.id, status: { notIn: ["ACCEPTED", "FAILED"] } },
      data: { status: "FAILED", notes: "Camera verification timed out." },
    }),
    prisma.movement.updateMany({ where: { id: movementId, status: "VALIDATED" }, data: { status: "FAILED" } }),
  ]);
  throw new Error("Camera verification timed out; the gantry did not move.");
}

export async function verifyPutawayCapture(id: string, input: unknown): Promise<PutawayCaptureView> {
  const body = input as {
    imageDataUrl?: unknown;
    imageWidth?: unknown;
    imageHeight?: unknown;
    capturedAt?: unknown;
  } | null;
  if (!body || typeof body.imageDataUrl !== "string" || body.imageDataUrl.length > 7_000_000
    || !/^data:image\/(jpeg|png|webp);base64,/i.test(body.imageDataUrl)
    || !Number.isInteger(body.imageWidth) || Number(body.imageWidth) <= 0
    || !Number.isInteger(body.imageHeight) || Number(body.imageHeight) <= 0
    || typeof body.capturedAt !== "number" || !Number.isFinite(body.capturedAt)) {
    throw new Error("A fresh camera frame, dimensions and capture time are required.");
  }

  const gantry = await getGantryController().getStatus();
  if (gantry.state !== "IDLE" || gantry.activeOperationId) throw new Error("Wait for the gantry to stop before capture.");
  const claimed = await prisma.putawayCaptureRequest.updateMany({
    where: { id, status: "WAITING_FOR_CAMERA", expiresAt: { gt: new Date() } },
    data: { status: "CAPTURING" },
  });
  if (claimed.count !== 1) throw new Error("This capture is stale or no longer pending.");

  let imageUrl: string | null = null;
  try {
    const capture = await prisma.putawayCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { part: true, destinationBin: true } } },
    });
    const { movement } = capture;
    if (movement.status !== "VALIDATED" || !movement.destinationBin
      || !PUTAWAY_CAPTURE_MARKERS.includes(movement.destinationLocation ?? "")
      || body.capturedAt < capture.createdAt.getTime() || body.capturedAt > Date.now() + 60_000) {
      throw new Error("This capture is stale or no longer pending.");
    }

    imageUrl = await uploadPutawayPhoto(`verification-${movement.id}-${capture.attempt}`, body.imageDataUrl);
    const imageBytes = Buffer.from(body.imageDataUrl.slice(body.imageDataUrl.indexOf(",") + 1), "base64");
    const part = movement.part;
    const vision = await countAuditImage(imageBytes, {
      binCode: movement.destinationBin.code,
      sku: part.sku,
      canonicalName: part.canonicalName,
      dimensions: { lengthMM: part.lengthMM, widthMM: part.widthMM, heightMM: part.heightMM },
    });
    const observed = vision.observedCount;
    const { outcome, foreignObjects } = classifyPutawayVision(vision, capture.expectedQuantity, movement.destinationBin.capacity);
    const nextStatus = outcome === "REVIEW_DECREASE" ? "REVIEW_DECREASE"
      : outcome === "READY" || outcome === "INCREASED" ? "READY"
      : "RETRY_REQUIRED";

    const capturedAt = new Date();
    const updated = await prisma.putawayCaptureRequest.update({
      where: { id },
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
        imageWidth: Number(body.imageWidth),
        imageHeight: Number(body.imageHeight),
        capturedAt,
      },
      include: { movement: { include: { destinationBin: true } } },
    });
    return captureView(updated, outcome);
  } catch (error) {
    await prisma.putawayCaptureRequest.updateMany({
      where: { id, status: "CAPTURING" },
      data: {
        status: "RETRY_REQUIRED",
        evidenceUrl: imageUrl,
        notes: "The image could not be analyzed. Take a fresh photo and retry.",
      },
    }).catch(() => {});
    throw error;
  }
}

export async function decidePutawayCapture(id: string, decision: PutawayCaptureDecision) {
  if (decision === "RETRY") {
    const reset = await prisma.putawayCaptureRequest.updateMany({
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
        expiresAt: new Date(Date.now() + CAPTURE_TIMEOUT_MS),
      },
    });
    if (reset.count !== 1) throw new Error("This verification can no longer be retried.");
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
      where: { id: capture.movementId, status: "VALIDATED" },
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
