import sharp from "sharp";
import {
  captureProcessingHeartbeatMilliseconds,
  createCaptureJob,
} from "@/lib/camera/capture-job-service";
import { readCameraCapture } from "@/lib/camera/storage";
import { getGantryController } from "@/lib/gantry/factory";
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
  clearSimulatedWorkflowCapture,
  hasSimulationEvidence,
  isSimulatedWorkflowCapture,
  markSimulatedWorkflowCapture,
  nextSimulationEvidence,
  SimulationEvidenceError,
  simulationBaselineUrl,
} from "./simulation-evidence";
import { RETRIEVAL_DESTINATION } from "./retrieval-types";
import {
  RETRIEVAL_CAPTURE_CONFIDENCE_THRESHOLD,
  type RetrievalCaptureDecision,
  type RetrievalCaptureOutcome,
  type RetrievalCaptureView,
} from "./retrieval-capture-types";
import { getContextWorkflowSessionId } from "@/lib/agents/request-context";

/**
 * Marker written to Movement.destinationLocation while verification is in
 * flight, mirroring PUTAWAY_CAPTURE_MARKERS. Unlike putaway, a RETRIEVAL
 * movement has no destinationBin — dashboard-service.ts falls back to
 * destinationLocation to display "OUTPUT" for it — so this marker is always
 * restored to RETRIEVAL_DESTINATION once verification concludes, rather than
 * left in place the way putaway leaves VERIFY_PUTAWAY/VERIFY_RETURN.
 */
export const RETRIEVAL_CAPTURE_MARKER = "VERIFY_RETRIEVAL";
const ACTIONABLE_CAPTURE_STATUSES = ["READY", "REVIEW_DECREASE"];
const RETRYABLE_CAPTURE_STATUSES = [
  "READY",
  "REVIEW_DECREASE",
  "RETRY_REQUIRED",
  "ANALYSIS_FAILED",
];
const RECOVERABLE_CAPTURE_STATUSES = [
  "WAITING_FOR_CAMERA",
  ...RETRYABLE_CAPTURE_STATUSES,
];

function isRetrievalSimulationMode(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && isSimulationEligibleBin(binCode);
}

/** Retrieval owns only its expected/observed quantity decision. */
function classifyRetrievalVision(
  vision: BinInspectionEvidence,
  expectedQuantity: number,
  capacity: number,
): { outcome: RetrievalCaptureOutcome; foreignObjects: string[] } {
  const assessment = assessBinInspection(vision, {
    confidenceThreshold: RETRIEVAL_CAPTURE_CONFIDENCE_THRESHOLD,
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
  movement: { sourceBin: { code: string } | null };
}, outcome: RetrievalCaptureOutcome, captureMode: "PROD" | "SIMULATION"): RetrievalCaptureView {
  return {
    captureMode,
    captureId: input.id,
    binCode: input.movement.sourceBin?.code ?? "bin",
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
  movement: { sourceBin: { capacity: number } | null };
}): RetrievalCaptureOutcome | null {
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
    input.movement.sourceBin &&
    input.observedQuantity > input.movement.sourceBin.capacity
  ) {
    return "CAPACITY_EXCEEDED";
  }
  return "LOW_CONFIDENCE";
}

async function latestSnapshotBefore(binId: string, movementId: string): Promise<string | null> {
  const [movement, audit] = await Promise.all([
    prisma.movement.findFirst({
      where: {
        id: { not: movementId },
        OR: [{ destinationBinId: binId }, { sourceBinId: binId }],
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
  if (!movement) return audit?.evidenceUrl ?? null;
  if (!audit) return movement.verificationImageUrl;
  return movement.verificationCapturedAt! >= audit.capturedAt!
    ? movement.verificationImageUrl
    : audit.evidenceUrl;
}

export async function pendingRetrievalCapture(ownerSessionId: string) {
  const capture = await prisma.retrievalCaptureRequest.findFirst({
    where: {
      status: { in: RECOVERABLE_CAPTURE_STATUSES },
      ownerSessionId,
      movement: { status: "RUNNING" },
    },
    include: { movement: { include: { sourceBin: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!capture) return { captureId: null };

  const captureMode = isSimulatedWorkflowCapture(capture.id)
    || isRetrievalSimulationMode(capture.movement.sourceBin?.code ?? "")
    ? "SIMULATION" as const
    : "PROD" as const;
  const outcome = persistedCaptureOutcome(capture);
  return {
    captureId: capture.id,
    binCode: capture.movement.sourceBin?.code ?? "bin",
    purpose: "RETRIEVAL" as const,
    captureMode,
    analysis: outcome ? captureView(capture, outcome, captureMode) : null,
  };
}

/** Analyze the next simulation fixture, or request one physical Pi frame. */
export async function requestRetrievalCameraCapture(
  id: string,
  ownerSessionId?: string,
): Promise<
  | { captureMode: "SIMULATION"; result: RetrievalCaptureView }
  | { captureMode: "PROD"; job: Awaited<ReturnType<typeof createCaptureJob>> }
> {
  const capture = await prisma.retrievalCaptureRequest.findUnique({
    where: { id },
    include: { movement: { include: { sourceBin: true } } },
  });
  if (capture && ownerSessionId && capture.ownerSessionId !== ownerSessionId) {
    throw new Error("This retrieval verification belongs to another operator session.");
  }
  if (!capture || capture.status !== "WAITING_FOR_CAMERA") {
    throw new Error("This retrieval verification is stale or no longer pending.");
  }
  if (capture.movement.status !== "RUNNING") {
    throw new Error("This retrieval is no longer waiting for verification.");
  }
  const gantry = await getGantryController().getStatus();
  if (gantry.state !== "IDLE" || gantry.activeOperationId) {
    throw new Error("Wait for the gantry to stop before requesting a photo.");
  }

  const binCode = capture.movement.sourceBin?.code;
  if (binCode && isOutOfSimulationScope(binCode)) {
    throw new SimulationScopeError(binCode);
  }
  const simulated = isSimulatedWorkflowCapture(id)
    || (binCode ? isRetrievalSimulationMode(binCode) : false);
  if (simulated) {
    if (!binCode) throw new Error("The retrieval source bin is missing.");
    markSimulatedWorkflowCapture(id);
    const sample = await nextSimulationEvidence(binCode);
    const metadata = await sharp(sample.bytes).metadata();
    const requestedAt = new Date();
    const result = await processRetrievalCameraCapture(id, {
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
      purpose: "RETRIEVAL_VERIFICATION",
      workflowCaptureId: id,
      status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] },
    },
    orderBy: { requestedAt: "desc" },
  });
  const job = existing ?? await createCaptureJob({
    purpose: "RETRIEVAL_VERIFICATION",
    ownerSessionId: capture.ownerSessionId,
    workflowCaptureId: id,
    workflowAttempt: capture.attempt,
  });
  return { captureMode: "PROD", job };
}

/**
 * Blocks the machine workflow until its selected capture is analyzed and
 * accepted. Called AFTER the gantry has already carried the bin to OUTPUT —
 * unlike putaway, a failure here must NOT commit any terminal Movement/Bin
 * state, because the bin is still physically sitting at OUTPUT. The caller
 * (executeRetrieval, which owns the gantry controller) is solely responsible
 * for physically returning the bin and reconciling DB state once this
 * function throws — mirroring how it already handles a gantry_failed result.
 */
export async function requireRetrievalVerification(movementId: string) {
  const movement = await prisma.movement.findUniqueOrThrow({
    where: { id: movementId },
    include: { sourceBin: true },
  });
  if (!movement.sourceBin) throw new Error("Retrieval source bin is missing.");
  const expectedQuantity = movement.quantity;

  // Refuse before creating any capture request: Simulation mode must never
  // silently fall through to a real capture on a bin it doesn't cover.
  if (isOutOfSimulationScope(movement.sourceBin.code)) {
    throw new SimulationScopeError(movement.sourceBin.code);
  }

  const simulated = isRetrievalSimulationMode(movement.sourceBin.code);
  const simulatedBaseline = simulated
    ? await simulationBaselineUrl(movement.sourceBin.code)
    : null;
  if (simulated && (!simulatedBaseline || !await hasSimulationEvidence(movement.sourceBin.code))) {
    throw new SimulationEvidenceError(movement.sourceBin.code);
  }

  const request = await prisma.retrievalCaptureRequest.create({
    data: {
      movementId,
      ownerSessionId: getContextWorkflowSessionId(),
      expectedQuantity,
      previousImageUrl: simulatedBaseline
        ?? await latestSnapshotBefore(movement.sourceBin.id, movementId),
      expiresAt: null,
    },
  });
  if (simulated) markSimulatedWorkflowCapture(request.id);
  await prisma.movement.update({
    where: { id: movementId },
    data: { destinationLocation: RETRIEVAL_CAPTURE_MARKER },
  });

  while (true) {
    const current = await prisma.retrievalCaptureRequest.findUniqueOrThrow({ where: { id: request.id } });
    if (current.status === "FAILED") {
      clearSimulatedWorkflowCapture(request.id);
      throw new Error("Retrieval verification failed.");
    }
    if (current.status === "ACCEPTED" && current.evidenceUrl && current.capturedAt && current.observedQuantity !== null) {
      clearSimulatedWorkflowCapture(request.id);
      await prisma.movement.updateMany({
        where: { id: movementId, status: "RUNNING" },
        data: { destinationLocation: RETRIEVAL_DESTINATION },
      });
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
      const expired = await prisma.retrievalCaptureRequest.updateMany({
        where: {
          id: request.id,
          status: "CAPTURING",
          expiresAt: { lte: now },
        },
        data: { status: "FAILED", notes: "Camera verification timed out." },
      });
      // A concurrent upload/analysis/decision may have renewed the deadline
      // after our read. Only the process that atomically claims the expired
      // row restores the marker and fails the wait.
      if (expired.count === 0) continue;
      await prisma.movement.updateMany({
        where: { id: movementId, status: "RUNNING" },
        data: { destinationLocation: RETRIEVAL_DESTINATION },
      });
      clearSimulatedWorkflowCapture(request.id);
      throw new Error("Camera verification timed out; the bin is being returned to its shelf.");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

interface RetrievalAnalysisInput {
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

async function analyzeRetrievalCapture(
  id: string,
  input: RetrievalAnalysisInput,
  claimFrom: "WAITING_FOR_CAMERA" | "ANALYSIS_FAILED",
): Promise<RetrievalCaptureView> {
  const captureMode = input.captureMode ?? "PROD";
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0
    || !input.evidenceUrl
    || !Number.isInteger(input.imageWidth) || input.imageWidth <= 0
    || !Number.isInteger(input.imageHeight) || input.imageHeight <= 0
    || !Number.isFinite(input.capturedAt.getTime())) {
    throw new Error("A fresh capture frame and valid metadata are required.");
  }
  if (claimFrom === "WAITING_FOR_CAMERA") {
    const gantry = await getGantryController().getStatus();
    if (gantry.state !== "IDLE" || gantry.activeOperationId) {
      throw new Error("Wait for the gantry to stop before capture.");
    }
  }
  const claimed = await prisma.retrievalCaptureRequest.updateMany({
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
    const capture = await prisma.retrievalCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { part: true, sourceBin: true } } },
    });
    const { movement } = capture;
    if (movement.status !== "RUNNING" || !movement.sourceBin
      || movement.destinationLocation !== RETRIEVAL_CAPTURE_MARKER
      || capture.attempt !== input.workflowAttempt
      || input.capturedAt.getTime() < input.requestedAt.getTime()
      || input.capturedAt.getTime() > Date.now() + 60_000) {
      throw new Error("This capture is stale or no longer pending.");
    }

    const part = movement.part;
    const leaseHeartbeat = setInterval(() => {
      void prisma.retrievalCaptureRequest.updateMany({
        where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
        data: { expiresAt: captureProcessingDeadline() },
      }).catch(() => {});
    }, captureProcessingHeartbeatMilliseconds());
    let vision: BinInspectionEvidence;
    try {
      vision = await inspectBinImage(input.imageBuffer, {
        binCode: movement.sourceBin.code,
        sku: part.sku,
        canonicalName: part.canonicalName,
        dimensions: { lengthMM: part.lengthMM, widthMM: part.widthMM, heightMM: part.heightMM },
      });
    } finally {
      clearInterval(leaseHeartbeat);
    }
    const processingRenewed = await prisma.retrievalCaptureRequest.updateMany({
      where: { id, status: "CAPTURING", attempt: input.workflowAttempt },
      data: { expiresAt: captureProcessingDeadline() },
    });
    if (processingRenewed.count !== 1) {
      throw new Error("This capture stopped being processable during image analysis.");
    }
    const observed = vision.observedCount;
    const { outcome, foreignObjects } = classifyRetrievalVision(vision, capture.expectedQuantity, movement.sourceBin.capacity);
    const nextStatus = outcome === "REVIEW_DECREASE" ? "REVIEW_DECREASE"
      : outcome === "READY" || outcome === "INCREASED" ? "READY"
      : "RETRY_REQUIRED";

    const capturedAt = input.capturedAt;
    const persisted = await prisma.retrievalCaptureRequest.updateMany({
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
    const updated = await prisma.retrievalCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { sourceBin: true } } },
    });
    return captureView(updated, outcome, captureMode);
  } catch (error) {
    console.error(`[retrieval-verification] Analysis failed for ${id}:`, error);
    await prisma.retrievalCaptureRequest.updateMany({
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
    const failed = await prisma.retrievalCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: { movement: { include: { sourceBin: true } } },
    });
    return captureView(failed, "ANALYSIS_FAILED", captureMode);
  }
}

export function processRetrievalCameraCapture(
  id: string,
  input: RetrievalAnalysisInput,
): Promise<RetrievalCaptureView> {
  return analyzeRetrievalCapture(id, input, "WAITING_FOR_CAMERA");
}

/** Re-runs inspection against the durable JPEG without asking the Pi to recapture. */
export async function reanalyzeRetrievalCapture(
  id: string,
  ownerSessionId: string,
): Promise<RetrievalCaptureView> {
  const capture = await prisma.retrievalCaptureRequest.findUnique({
    where: { id },
    include: { movement: { include: { sourceBin: true } } },
  });
  if (!capture || capture.ownerSessionId !== ownerSessionId) {
    throw new Error("This retrieval verification belongs to another operator session.");
  }
  if (
    capture.status !== "ANALYSIS_FAILED" ||
    !capture.evidenceUrl ||
    !capture.capturedAt ||
    !capture.imageWidth ||
    !capture.imageHeight
  ) {
    throw new Error("This retrieval has no failed saved frame to analyze again.");
  }
  const job = await prisma.cameraCaptureJob.findFirst({
    where: {
      purpose: "RETRIEVAL_VERIFICATION",
      workflowCaptureId: id,
      workflowAttempt: capture.attempt,
      evidenceUrl: capture.evidenceUrl,
    },
    orderBy: { requestedAt: "desc" },
  });
  if (!job) throw new Error("The saved camera job could not be found.");

  const imageBuffer = await readCameraCapture(job.id);
  return analyzeRetrievalCapture(
    id,
    {
      imageBuffer,
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

export async function decideRetrievalCapture(
  id: string,
  decision: RetrievalCaptureDecision,
  ownerSessionId?: string,
) {
  if (ownerSessionId) {
    const owner = await prisma.retrievalCaptureRequest.findUnique({
      where: { id },
      select: { ownerSessionId: true },
    });
    if (!owner || owner.ownerSessionId !== ownerSessionId) {
      throw new Error("This retrieval verification belongs to another operator session.");
    }
  }
  if (decision === "CANCEL") {
    // Give the operator a real way out of a stuck comparison (e.g. every
    // retry keeps landing on LOW_CONFIDENCE/FOREIGN_OBJECTS, offering only
    // Retry). Flipping the row straight to FAILED reuses the exact path a
    // CAPTURING timeout already takes: requireRetrievalVerification's poll
    // observes FAILED and throws, and executeRetrieval's own catch block
    // sends the bin back to its shelf via gantry.returnBin — nothing here
    // touches the gantry directly.
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.retrievalCaptureRequest.updateMany({
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
          errorMessage: "The operator cancelled this retrieval verification.",
          updatedAt: new Date(),
        },
      });
    });
    return { ok: true, status: "FAILED" as const };
  }

  if (decision === "RETRY") {
    await prisma.$transaction(async (tx) => {
      const reset = await tx.retrievalCaptureRequest.updateMany({
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
          errorMessage: "A newer retrieval verification attempt replaced this capture.",
          updatedAt: new Date(),
        },
      });
    });
    return { ok: true, status: "WAITING_FOR_CAMERA" as const };
  }

  const capture = await prisma.retrievalCaptureRequest.findUnique({ where: { id } });
  if (!capture || !ACTIONABLE_CAPTURE_STATUSES.includes(capture.status)
    || capture.observedQuantity === null || !capture.evidenceUrl || !capture.capturedAt) {
    throw new Error("This verification cannot be accepted.");
  }
  // Unlike putaway, accepting does not itself write Movement fields — the
  // bin has already physically moved, so executeRetrieval's own commit
  // transaction (reached once requireRetrievalVerification's poll observes
  // ACCEPTED) is what writes the verified quantity onto Bin/Movement.
  const accepted = await prisma.retrievalCaptureRequest.updateMany({
    where: { id, status: capture.status },
    data: { status: "ACCEPTED" },
  });
  if (accepted.count !== 1) throw new Error("This verification was already decided.");
  return { ok: true, status: "ACCEPTED" as const };
}
