import sharp from "sharp";
import {
  captureProcessingHeartbeatMilliseconds,
  createCaptureJob,
} from "@/lib/camera/capture-job-service";
import { readCameraCapture } from "@/lib/camera/storage";
import { prisma } from "./db";
import { confidencePercent } from "./audit-types";
import {
  assessBinInspection,
  inspectBinImage,
  parseInspectionForeignObjects,
  type BinInspectionEvidence,
} from "./bin-inspection-service";
import {
  getAuditCaptureMode,
  isOutOfSimulationScope,
  isSimulationEligibleBin,
  SimulationScopeError,
} from "./audit-capture-mode";
import { captureProcessingDeadline } from "./capture-deadlines";
import {
  putawayInactivityTimeoutMs,
  recoverAbandonedPutaways,
} from "./putaway-recovery-service";
import {
  clearSimulatedWorkflowCapture,
  hasSimulationEvidence,
  isSimulatedWorkflowCapture,
  markSimulatedWorkflowCapture,
  nextSimulationEvidence,
  SimulationEvidenceError,
  simulationBaselineUrl,
} from "./simulation-evidence";
import {
  PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
  type PutawayCaptureDecision,
  type PutawayCaptureOutcome,
  type PutawayCaptureView,
} from "./putaway-capture-types";
import {
  getContextAutoSuggestedReturn,
  getContextWorkflowSessionId,
} from "@/lib/agents/request-context";

export const PUTAWAY_CAPTURE_MARKERS = ["VERIFY_PUTAWAY", "VERIFY_RETURN"];
const ACTIONABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE"];
const RETRYABLE_CAPTURE_STATUSES = [
  "READY",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
  "ANALYSIS_FAILED",
];
const RECOVERABLE_CAPTURE_STATUSES = ["WAITING_FOR_CAMERA", ...RETRYABLE_CAPTURE_STATUSES];

function isPutawaySimulationMode(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && isSimulationEligibleBin(binCode);
}

/** Shared real/simulated putaway vision policy. */
function classifyPutawayVision(
  vision: BinInspectionEvidence,
  expectedQuantity: number,
  capacity: number,
): { outcome: PutawayCaptureOutcome; foreignObjects: string[] } {
  const assessment = assessBinInspection(vision, {
    confidenceThreshold: PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
    capacity,
    requireExpectedPart: true,
  });
  if (assessment.gate !== "CLEAR") {
    return { outcome: assessment.gate, foreignObjects: assessment.foreignObjects };
  }
  const outcome = assessment.observedQuantity < expectedQuantity
    ? "REVIEW_DECREASE"
    : assessment.observedQuantity > expectedQuantity
      ? "INCREASED"
      : "READY";
  return { outcome, foreignObjects: assessment.foreignObjects };
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
}, outcome: PutawayCaptureOutcome, captureMode: "PROD" | "SIMULATION"): PutawayCaptureView {
  return {
    captureMode,
    captureId: input.id,
    binCode: input.movement.destinationBin?.code ?? "bin",
    status: input.status,
    outcome,
    expectedQuantity: input.expectedQuantity,
    observedQuantity: input.observedQuantity,
    confidencePercent: input.countConfidence === null ? null : confidencePercent(input.countConfidence),
    previousImageUrl: input.previousImageUrl,
    currentImageUrl: input.evidenceUrl,
    foreignObjects: parseInspectionForeignObjects(input.foreignObjectsJson),
    notes: input.notes,
  };
}

function persistedCaptureOutcome(input: {
  status: string;
  expectedQuantity: number;
  observedQuantity: number | null;
  foreignObjectSuspected: boolean | null;
  movement: { destinationBin: { capacity: number } | null };
}): PutawayCaptureOutcome | null {
  if (input.status === "ANALYSIS_FAILED") return "ANALYSIS_FAILED";
  if (input.status === "REVIEW_DECREASE") return "REVIEW_DECREASE";
  if (input.status === "READY") {
    return (input.observedQuantity ?? input.expectedQuantity) > input.expectedQuantity
      ? "INCREASED"
      : "READY";
  }
  if (input.status !== "RETRY_REQUIRED") return null;
  if (input.foreignObjectSuspected) return "FOREIGN_OBJECTS";
  if (
    input.observedQuantity !== null &&
    input.movement.destinationBin &&
    input.observedQuantity > input.movement.destinationBin.capacity
  ) {
    return "CAPACITY_EXCEEDED";
  }
  return "LOW_CONFIDENCE";
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

export async function pendingPutawayCapture(ownerSessionId: string) {
  await recoverAbandonedPutaways();
  const capture = await prisma.putawayCaptureRequest.findFirst({
    where: {
      // A browser may reload after analysis but before the operator accepts or
      // retries. Those review states still own the bin and must be surfaced
      // again; otherwise the server waits forever while the UI sees nothing.
      status: { in: RECOVERABLE_CAPTURE_STATUSES },
      ownerSessionId,
      movement: { status: { in: ["VALIDATED", "AWAITING_PLACEMENT"] } },
    },
    include: { movement: { include: { destinationBin: true } } },
    // A leaked older attempt must not hide the operation the operator just
    // started. Newest-first is also the least surprising recovery policy if
    // an older server request died before releasing its reservation.
    orderBy: { createdAt: "desc" },
  });
  if (!capture) return { captureId: null };

  const captureMode = isSimulatedWorkflowCapture(capture.id)
    || isPutawaySimulationMode(capture.movement.destinationBin?.code ?? "")
    ? "SIMULATION" as const
    : "PROD" as const;
  const outcome = persistedCaptureOutcome(capture);
  return {
    captureId: capture.id,
    binCode: capture.movement.destinationBin?.code ?? "bin",
    purpose: "PUTAWAY" as const,
    captureMode,
    analysis: outcome ? captureView(capture, outcome, captureMode) : null,
  };
}

/** Analyze the next simulation fixture, or request one physical Pi frame. */
export async function requestPutawayCameraCapture(
  id: string,
  ownerSessionId?: string,
): Promise<
  | { captureMode: "SIMULATION"; result: PutawayCaptureView }
  | { captureMode: "PROD"; job: Awaited<ReturnType<typeof createCaptureJob>> }
> {
  const capture = await prisma.putawayCaptureRequest.findUnique({
    where: { id },
    include: { movement: { include: { destinationBin: true } } },
  });
  if (capture && ownerSessionId && capture.ownerSessionId !== ownerSessionId) {
    throw new Error("This putaway verification belongs to another operator session.");
  }
  if (!capture || capture.status !== "WAITING_FOR_CAMERA") {
    throw new Error("This putaway verification is stale or no longer pending.");
  }
  if (!["VALIDATED", "AWAITING_PLACEMENT"].includes(capture.movement.status)) {
    throw new Error("This putaway is no longer waiting for verification.");
  }
  const binCode = capture.movement.destinationBin?.code;
  if (binCode && isOutOfSimulationScope(binCode)) {
    throw new SimulationScopeError(binCode);
  }
  const simulated = isSimulatedWorkflowCapture(id)
    || (binCode ? isPutawaySimulationMode(binCode) : false);
  if (simulated) {
    if (!binCode) throw new Error("The putaway destination is missing.");
    markSimulatedWorkflowCapture(id);
    const sample = await nextSimulationEvidence(binCode);
    const metadata = await sharp(sample.bytes).metadata();
    const requestedAt = new Date();
    const result = await processPutawayCameraCapture(id, {
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
      purpose: "PUTAWAY_VERIFICATION",
      workflowCaptureId: id,
      status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
    },
    orderBy: { requestedAt: "desc" },
  });
  const job = existing ?? await createCaptureJob({
    purpose: "PUTAWAY_VERIFICATION",
    ownerSessionId: capture.ownerSessionId,
    workflowCaptureId: id,
    workflowAttempt: capture.attempt,
  });
  return { captureMode: "PROD", job };
}

/** Blocks the machine workflow until its selected capture is analyzed and accepted. */
export async function requirePutawayVerification(
  movementId: string,
  isReturn = false,
): Promise<{ imageUrl: string; capturedAt: Date; quantity: number; simulated: boolean }> {
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

  // Simulation goes through the SAME PutawayCaptureRequest state machine as
  // a real capture (see requestPutawayCameraCapture) — no invisible
  // server-only shortcut — so the comparison popup, Retry and Cancel all
  // work identically whether the photo is real or a curated fixture.
  const simulated = isPutawaySimulationMode(movement.destinationBin.code);
  const simulatedBaseline = simulated
    ? await simulationBaselineUrl(movement.destinationBin.code)
    : null;
  if (simulated && (!simulatedBaseline || !await hasSimulationEvidence(movement.destinationBin.code))) {
    throw new SimulationEvidenceError(movement.destinationBin.code);
  }

  const request = await prisma.putawayCaptureRequest.create({
    data: {
      movementId,
      ownerSessionId: getContextWorkflowSessionId(),
      expectedQuantity,
      previousImageUrl: simulatedBaseline
        ?? await latestSnapshotBefore(movement.destinationBin.id, movementId),
      expiresAt: null,
    },
  });
  if (simulated) markSimulatedWorkflowCapture(request.id);
  await prisma.movement.update({
    where: { id: movementId },
    data: { destinationLocation: isReturn ? "VERIFY_RETURN" : "VERIFY_PUTAWAY" },
  });

  // The operator already approved this exact physical action by clicking the
  // auto-suggested "put it back?" card — a second click just to START the
  // camera adds no safety, only friction. requestPutawayCameraCapture is
  // idempotent (PROD reuses any existing CameraCaptureJob, SIMULATION just
  // runs its analysis once), so this is safe even if the popup also fires it.
  // The decision on whatever the photo shows still belongs to the operator,
  // same as any other putaway — only the capture TRIGGER is automatic.
  if (getContextAutoSuggestedReturn()) {
    await requestPutawayCameraCapture(request.id, request.ownerSessionId ?? undefined);
  }

  while (true) {
    const current = await prisma.putawayCaptureRequest.findUniqueOrThrow({ where: { id: request.id } });
    if (current.status === "FAILED") {
      clearSimulatedWorkflowCapture(request.id);
      throw new Error("Putaway verification failed.");
    }
    if (current.status === "ACCEPTED" && current.evidenceUrl && current.capturedAt && current.observedQuantity !== null) {
      clearSimulatedWorkflowCapture(request.id);
      return {
        imageUrl: current.evidenceUrl,
        capturedAt: current.capturedAt,
        quantity: current.observedQuantity,
        simulated,
      };
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
      clearSimulatedWorkflowCapture(request.id);
      throw new Error("Camera verification timed out; the gantry did not move.");
    }
    if (
      current.status !== "CAPTURING" &&
      current.updatedAt.getTime() <= Date.now() - putawayInactivityTimeoutMs()
    ) {
      await recoverAbandonedPutaways();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

interface PutawayAnalysisInput {
  imageBuffer: Buffer;
  evidenceUrl: string;
  imageWidth: number;
  imageHeight: number;
  capturedAt: Date;
  requestedAt: Date;
  workflowAttempt: number;
  captureMode?: "PROD" | "SIMULATION";
}

function analysisFailureNote(error: unknown): string {
  const detail = error instanceof Error && error.message.trim()
    ? error.message.trim().replace(/\s+/g, " ").slice(0, 360)
    : "unknown_analysis_error";
  return `The saved photo could not be analyzed (${detail}). Retry analysis without taking another photo.`;
}

async function analyzePutawayCapture(
  id: string,
  input: PutawayAnalysisInput,
  claimFrom: "WAITING_FOR_CAMERA" | "ANALYSIS_FAILED",
): Promise<PutawayCaptureView> {
  const captureMode = input.captureMode ?? "PROD";
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0
    || !input.evidenceUrl
    || !Number.isInteger(input.imageWidth) || input.imageWidth <= 0
    || !Number.isInteger(input.imageHeight) || input.imageHeight <= 0
    || !Number.isFinite(input.capturedAt.getTime())) {
    throw new Error("A fresh capture frame and valid metadata are required.");
  }
  const claimed = await prisma.putawayCaptureRequest.updateMany({
    where: { id, status: claimFrom, attempt: input.workflowAttempt },
    data: {
      status: "CAPTURING",
      notes: null,
      expiresAt: captureProcessingDeadline(),
    },
  });
  if (claimed.count !== 1) throw new Error("This capture is stale or no longer pending.");

  const imageUrl = input.evidenceUrl;
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

    const part = movement.part;
    const leaseHeartbeat = setInterval(() => {
      void prisma.putawayCaptureRequest.updateMany({
        where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
        data: { expiresAt: captureProcessingDeadline() },
      }).catch(() => {});
    }, captureProcessingHeartbeatMilliseconds());
    let vision: BinInspectionEvidence;
    try {
      vision = await inspectBinImage(input.imageBuffer, {
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
    return captureView(updated, outcome, captureMode);
  } catch (error) {
    console.error(`[putaway-verification] Analysis failed for ${id}:`, error);
    await prisma.putawayCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: {
        status: "ANALYSIS_FAILED",
        evidenceUrl: imageUrl,
        imageWidth: input.imageWidth,
        imageHeight: input.imageHeight,
        capturedAt: input.capturedAt,
        observedQuantity: null,
        countConfidence: null,
        countable: null,
        expectedPartPresent: null,
        foreignObjectSuspected: null,
        foreignObjectsJson: null,
        occlusion: null,
        notes: captureMode === "SIMULATION"
          ? "The simulated frame could not be analyzed. Run the next simulation."
          : analysisFailureNote(error),
        expiresAt: null,
      },
    });
    const failed = await prisma.putawayCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { destinationBin: true } } },
    });
    return captureView(failed, "ANALYSIS_FAILED", captureMode);
  }
}

export function processPutawayCameraCapture(
  id: string,
  input: PutawayAnalysisInput,
): Promise<PutawayCaptureView> {
  return analyzePutawayCapture(id, input, "WAITING_FOR_CAMERA");
}

/** Re-runs putaway inspection against the durable JPEG without recapturing. */
export async function reanalyzePutawayCapture(
  id: string,
  ownerSessionId: string,
): Promise<PutawayCaptureView> {
  const capture = await prisma.putawayCaptureRequest.findUnique({
    where: { id },
    include: { movement: { include: { destinationBin: true } } },
  });
  if (!capture || capture.ownerSessionId !== ownerSessionId) {
    throw new Error("This putaway verification belongs to another operator session.");
  }
  if (
    capture.status !== "ANALYSIS_FAILED" ||
    !capture.evidenceUrl ||
    !capture.capturedAt ||
    !capture.imageWidth ||
    !capture.imageHeight
  ) {
    throw new Error("This putaway has no failed saved frame to analyze again.");
  }
  const job = await prisma.cameraCaptureJob.findFirst({
    where: {
      purpose: "PUTAWAY_VERIFICATION",
      workflowCaptureId: id,
      workflowAttempt: capture.attempt,
      evidenceUrl: capture.evidenceUrl,
    },
    orderBy: { requestedAt: "desc" },
  });
  if (!job) throw new Error("The saved camera job could not be found.");

  return analyzePutawayCapture(
    id,
    {
      imageBuffer: await readCameraCapture(job.id),
      evidenceUrl: capture.evidenceUrl,
      imageWidth: capture.imageWidth,
      imageHeight: capture.imageHeight,
      capturedAt: capture.capturedAt,
      requestedAt: job.requestedAt,
      workflowAttempt: capture.attempt,
      captureMode: "PROD",
    },
    "ANALYSIS_FAILED",
  );
}

export async function decidePutawayCapture(
  id: string,
  decision: PutawayCaptureDecision,
  ownerSessionId?: string,
) {
  if (ownerSessionId) {
    const owner = await prisma.putawayCaptureRequest.findUnique({
      where: { id },
      select: { ownerSessionId: true },
    });
    if (!owner || owner.ownerSessionId !== ownerSessionId) {
      throw new Error("This putaway verification belongs to another operator session.");
    }
  }
  if (decision === "CANCEL") {
    // Give the operator a real way out of a stuck comparison (e.g. every
    // retry keeps landing on LOW_CONFIDENCE/FOREIGN_OBJECTS, offering only
    // Retry). Flipping the row straight to FAILED reuses the exact path a
    // CAPTURING timeout already takes: requirePutawayVerification's poll
    // observes FAILED and throws, and the owning service's catch block
    // (releaseClaim) unwinds the reservation — nothing here touches the
    // gantry or Movement directly.
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.putawayCaptureRequest.updateMany({
        where: { id, status: { in: [...RETRYABLE_CAPTURE_STATUSES, "WAITING_FOR_CAMERA"] } },
        data: { status: "FAILED", notes: "Cancelled by operator." },
      });
      if (cancelled.count !== 1) throw new Error("This verification can no longer be cancelled.");
      await tx.cameraCaptureJob.updateMany({
        where: {
          workflowCaptureId: id,
          status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          errorCode: "camera_job_superseded",
          errorMessage: "The operator cancelled this putaway verification.",
          updatedAt: new Date(),
        },
      });
    });
    return { ok: true, status: "FAILED" as const };
  }

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
