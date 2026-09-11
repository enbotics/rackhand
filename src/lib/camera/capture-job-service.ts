import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/warehouse/db";

/**
 * Camera capture purposes.
 *
 * MANUAL_SCAN:
 *   Operator presses "Scan Part".
 *
 * INVENTORY_AUDIT:
 *   Inventory Audit Graph requests a physical image of a bin.
 *
 * RECOUNT:
 *   Human explicitly requests a fresh physical recount.
 *
 * PUTAWAY_VERIFICATION:
 *   A returned/presented bin must be photographed before putaway continues.
 */
export const CAMERA_CAPTURE_PURPOSES = [
  "MANUAL_SCAN",
  "INVENTORY_AUDIT",
  "RECOUNT",
  "PUTAWAY_VERIFICATION",
] as const;

export type CameraCapturePurpose = (typeof CAMERA_CAPTURE_PURPOSES)[number];

export const CAMERA_CAPTURE_STATUSES = [
  "PENDING",
  "CLAIMED",
  "UPLOADED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type CameraCaptureStatus = (typeof CAMERA_CAPTURE_STATUSES)[number];

const DEFAULT_CAPTURE_TIMEOUT_SECONDS = 2 * 60;
const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_ABANDONED_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 * Keep this small.
 *
 * Raspberry Pi queue claims never hold a DB transaction open while waiting
 * for hardware/network activity.
 */
const MAX_CLAIM_ATTEMPTS = 3;

export interface CreateCaptureJobInput {
  purpose: CameraCapturePurpose;

  /** Browser/operator workflow that alone may read this job's result. */
  ownerSessionId?: string | null;

  /**
   * Optional audit relation.
   *
   * Required for INVENTORY_AUDIT / RECOUNT once those flows are wired.
   */
  binAuditId?: string | null;

  /** Durable PutawayCaptureRequest/AuditCaptureRequest id for workflow photos. */
  workflowCaptureId?: string | null;

  /** Retry generation of the owning workflow capture. */
  workflowAttempt?: number | null;

  /**
   * Normally omitted.
   *
   * The server configuration chooses the Raspberry Pi device.
   * Keeping this optional makes tests easier and permits future
   * multi-camera support without changing this contract.
   */
  deviceId?: string;
}

export interface UploadedCaptureMetadata {
  evidenceUrl: string;

  imageWidth: number;
  imageHeight: number;

  capturedAt: Date;
}

export interface CompleteCaptureJobInput {
  /**
   * JSON-serializable application result.
   *
   * For MANUAL_SCAN this will usually be MeasurementResult.
   *
   * Audit results generally live in BinAudit/AuditReview instead,
   * so this may be null for an audit capture.
   */
  result?: unknown;
}

export interface FailCaptureJobInput {
  errorCode: string;
  errorMessage?: string | null;
}

export class CameraCaptureJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);

    this.name = "CameraCaptureJobError";
    this.code = code;
  }
}

function requireConfiguredDeviceId(): string {
  const deviceId = process.env.CAMERA_DEVICE_ID?.trim();

  if (!deviceId) {
    throw new CameraCaptureJobError(
      "camera_not_configured",
      "CAMERA_DEVICE_ID is not configured.",
    );
  }

  return deviceId;
}

function getCaptureTimeoutSeconds(): number {
  const raw =
    process.env.CAMERA_CAPTURE_TIMEOUT_SECONDS ??
    String(DEFAULT_CAPTURE_TIMEOUT_SECONDS);

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new CameraCaptureJobError(
      "camera_invalid_configuration",
      "CAMERA_CAPTURE_TIMEOUT_SECONDS must be a positive number.",
    );
  }

  return value;
}

function getProcessingTimeoutSeconds(): number {
  const raw =
    process.env.CAMERA_PROCESSING_TIMEOUT_SECONDS ??
    String(DEFAULT_PROCESSING_TIMEOUT_SECONDS);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CameraCaptureJobError(
      "camera_invalid_configuration",
      "CAMERA_PROCESSING_TIMEOUT_SECONDS must be a positive number.",
    );
  }
  return value;
}

function getAbandonedTimeoutSeconds(): number {
  const raw =
    process.env.CAMERA_ABANDONED_TIMEOUT_SECONDS ??
    String(DEFAULT_ABANDONED_TIMEOUT_SECONDS);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CameraCaptureJobError(
      "camera_invalid_configuration",
      "CAMERA_ABANDONED_TIMEOUT_SECONDS must be a positive number.",
    );
  }
  return value;
}

function calculateExpiryDate(now = new Date()): Date {
  const timeoutSeconds = getCaptureTimeoutSeconds();

  return new Date(now.getTime() + timeoutSeconds * 1000);
}

function calculateProcessingExpiryDate(now = new Date()): Date {
  return new Date(now.getTime() + getProcessingTimeoutSeconds() * 1000);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CameraCaptureJobError(
      "camera_invalid_metadata",
      `${name} must be a positive integer.`,
    );
  }
}

function sanitizeErrorMessage(
  message: string | null | undefined,
): string | null {
  if (!message) {
    return null;
  }

  // Do not persist unbounded hardware/network error text.
  return message.slice(0, 500);
}

/**
 * Create one camera request.
 *
 * Creating this record does NOT mean the Raspberry Pi has seen the request.
 * It only establishes server-side intent.
 */
export async function createCaptureJob(input: CreateCaptureJobInput) {
  if (!CAMERA_CAPTURE_PURPOSES.includes(input.purpose)) {
    throw new CameraCaptureJobError(
      "camera_invalid_purpose",
      `Unsupported camera purpose: ${input.purpose}`,
    );
  }

  const deviceId = input.deviceId?.trim() || requireConfiguredDeviceId();

  const now = new Date();

  return prisma.cameraCaptureJob.create({
    data: {
      id: randomUUID(),
      purpose: input.purpose,
      deviceId,
      ownerSessionId: input.ownerSessionId ?? null,

      status: "PENDING",

      binAuditId: input.binAuditId ?? null,
      workflowCaptureId: input.workflowCaptureId ?? null,
      workflowAttempt: input.workflowAttempt ?? null,

      requestedAt: now,
      // Queued work does not hold a short lease. It remains durable until a
      // device claims it, a retry supersedes it, or abandonment cleanup runs.
      expiresAt: null,
      updatedAt: now,
    },
  });
}

/**
 * Retrieve one job.
 *
 * Returns null rather than throwing if the id doesn't exist.
 */
export async function getCaptureJob(jobId: string) {
  return prisma.cameraCaptureJob.findUnique({
    where: {
      id: jobId,
    },
  });
}

/**
 * Retrieve one job and throw a stable application error when absent.
 */
export async function requireCaptureJob(jobId: string) {
  const job = await getCaptureJob(jobId);

  if (!job) {
    throw new CameraCaptureJobError(
      "camera_job_not_found",
      `Camera capture job ${jobId} does not exist.`,
    );
  }

  return job;
}

/** Browser ownership check; device-authenticated worker paths do not use it. */
export async function requireOwnedCaptureJob(
  jobId: string,
  ownerSessionId: string,
) {
  const job = await requireCaptureJob(jobId);
  if (job.ownerSessionId !== ownerSessionId) {
    throw new CameraCaptureJobError(
      "camera_job_not_owned",
      "This camera capture belongs to another operator session.",
    );
  }
  return job;
}

/**
 * Recover stale leases and cancel only genuinely abandoned queued jobs.
 *
 * This is intentionally callable from request paths; no background worker
 * is required for the MVP.
 */
export async function expireStaleCaptureJobs(
  now = new Date(),
): Promise<number> {
  const abandonedBefore = new Date(
    now.getTime() - getAbandonedTimeoutSeconds() * 1000,
  );
  const abandonedResult = await prisma.cameraCaptureJob.updateMany({
    where: {
      status: "PENDING",
      updatedAt: { lte: abandonedBefore },
    },

    data: {
      status: "CANCELLED",
      completedAt: now,
      errorCode: "camera_job_abandoned",
      errorMessage:
        "The camera capture request was cancelled after being abandoned.",
      updatedAt: now,
    },
  });

  // CLAIMED is a device lease. If the Pi disappears, return the same durable
  // job to the queue so a recovered worker can claim it again.
  const releasedClaims = await prisma.cameraCaptureJob.updateMany({
    where: {
      status: "CLAIMED",
      expiresAt: { lte: now },
    },
    data: {
      status: "PENDING",
      claimedAt: null,
      expiresAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    },
  });

  const processingDeadline = new Date(
    now.getTime() - getProcessingTimeoutSeconds() * 1000,
  );
  const processingResult = await prisma.cameraCaptureJob.updateMany({
    where: {
      status: { in: ["UPLOADED", "PROCESSING"] },
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, updatedAt: { lte: processingDeadline } },
      ],
    },
    data: {
      status: "FAILED",
      completedAt: now,
      errorCode: "camera_processing_timeout",
      errorMessage:
        "Camera processing stopped making progress and was recovered automatically.",
      updatedAt: now,
    },
  });

  return abandonedResult.count + releasedClaims.count + processingResult.count;
}

/**
 * Atomically claim the oldest pending job assigned to a Raspberry Pi.
 *
 * Important:
 *
 * findFirst() alone is NOT enough.
 *
 * Another worker could see the same row between find and update.
 * The conditional updateMany() below makes only one claimant win.
 */
export async function claimNextCaptureJob(deviceId: string) {
  const normalizedDeviceId = deviceId.trim();

  if (!normalizedDeviceId) {
    throw new CameraCaptureJobError(
      "camera_invalid_device",
      "Camera device id is required.",
    );
  }

  const now = new Date();

  // Opportunistically clean up timed-out jobs first.
  await expireStaleCaptureJobs(now);

  // One physical sensor may have many queued owners, but only one active
  // capture lease. This also protects against accidentally running two Pi
  // workers with the same device credentials.
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const activeClaim = await prisma.cameraCaptureJob.findFirst({
      where: { deviceId: normalizedDeviceId, status: "CLAIMED" },
      select: { id: true },
    });
    if (activeClaim) return null;

    const candidate = await prisma.cameraCaptureJob.findFirst({
      where: {
        deviceId: normalizedDeviceId,

        status: "PENDING",
      },

      orderBy: [
        {
          requestedAt: "asc",
        },
        {
          id: "asc",
        },
      ],
    });

    if (!candidate) {
      return null;
    }

    const claimedAt = new Date();

    const captureDeadline = new Date(
      claimedAt.getTime() + getCaptureTimeoutSeconds() * 1000,
    );

    const claimed = await prisma.cameraCaptureJob.updateMany({
      where: {
        id: candidate.id,
        deviceId: normalizedDeviceId,
        status: "PENDING",
      },

      data: {
        status: "CLAIMED",
        claimedAt,
        expiresAt: captureDeadline,
        updatedAt: claimedAt,
      },
    });

    if (claimed.count !== 1) {
      /**
       * Another worker/process claimed this candidate first.
       *
       * Retry and look for the next pending job.
       */
      continue;
    }

    return prisma.cameraCaptureJob.findUnique({
      where: {
        id: candidate.id,
      },
    });
  }

  /**
   * A race happened on all attempts.
   *
   * Returning null is better than accidentally giving the Pi the same
   * physical capture twice.
   */
  return null;
}

/**
 * Validate that an authenticated Raspberry Pi owns this job.
 */
export async function requireDeviceCaptureJob(jobId: string, deviceId: string) {
  const job = await requireCaptureJob(jobId);

  if (job.deviceId !== deviceId) {
    throw new CameraCaptureJobError(
      "camera_job_device_mismatch",
      "This camera device does not own the capture job.",
    );
  }

  return job;
}

/** Renew the authenticated Pi's ownership lease while it captures/uploads. */
export async function renewDeviceCaptureLease(jobId: string, deviceId: string) {
  await requireDeviceCaptureJob(jobId, deviceId);
  const now = new Date();
  const renewed = await prisma.cameraCaptureJob.updateMany({
    where: { id: jobId, deviceId, status: "CLAIMED" },
    data: {
      expiresAt: calculateExpiryDate(now),
      updatedAt: now,
    },
  });
  return renewed.count === 1;
}

/**
 * Called after:
 *
 * - device authentication
 * - multipart validation
 * - JPEG validation with Sharp
 * - evidence upload/storage
 *
 * This does NOT run Gemini.
 *
 * It records that the physical image is safely on the server/storage side.
 */
export async function markCaptureUploaded(
  jobId: string,
  deviceId: string,
  input: UploadedCaptureMetadata,
) {
  assertPositiveInteger(input.imageWidth, "imageWidth");

  assertPositiveInteger(input.imageHeight, "imageHeight");

  if (!input.evidenceUrl.trim()) {
    throw new CameraCaptureJobError(
      "camera_invalid_evidence",
      "evidenceUrl is required.",
    );
  }

  const now = new Date();

  const job = await requireDeviceCaptureJob(jobId, deviceId);

  /**
   * Idempotency:
   *
   * The Pi may have uploaded successfully but lost the HTTP response.
   * It will then retry the SAME job and SAME image.
   *
   * Do not convert that into another capture or another Gemini invocation.
   */
  if (
    job.status === "UPLOADED" ||
    job.status === "PROCESSING" ||
    job.status === "COMPLETED"
  ) {
    return job;
  }

  if (job.status === "EXPIRED") {
    throw new CameraCaptureJobError(
      "camera_job_expired",
      "The camera capture job has expired.",
    );
  }

  if (job.status === "CANCELLED") {
    throw new CameraCaptureJobError(
      "camera_job_cancelled",
      "The camera capture job was cancelled or superseded.",
    );
  }

  if (job.status === "FAILED") {
    throw new CameraCaptureJobError(
      "camera_job_failed",
      "The camera capture job is already failed.",
    );
  }

  if (job.status !== "CLAIMED") {
    throw new CameraCaptureJobError(
      "camera_invalid_job_state",
      `Cannot upload image while camera job is ${job.status}.`,
    );
  }

  if (job.expiresAt && job.expiresAt <= now) {
    await prisma.cameraCaptureJob.updateMany({
      where: {
        id: jobId,
        status: "CLAIMED",
      },

      data: {
        status: "PENDING",
        claimedAt: null,
        expiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      },
    });

    throw new CameraCaptureJobError(
      "camera_claim_lost",
      "The device lease ended before upload; the capture was safely requeued.",
    );
  }

  const updated = await prisma.cameraCaptureJob.updateMany({
    where: {
      id: jobId,
      deviceId,
      status: "CLAIMED",
      expiresAt: {
        gt: now,
      },
    },

    data: {
      status: "UPLOADED",

      evidenceUrl: input.evidenceUrl,

      imageWidth: input.imageWidth,

      imageHeight: input.imageHeight,

      capturedAt: input.capturedAt,

      uploadedAt: now,
      expiresAt: calculateProcessingExpiryDate(now),
      updatedAt: now,
    },
  });

  if (updated.count !== 1) {
    /**
     * Something changed between our read and write.
     * Re-read so duplicate upload races can still be treated idempotently.
     */
    const current = await requireDeviceCaptureJob(jobId, deviceId);

    if (
      current.status === "UPLOADED" ||
      current.status === "PROCESSING" ||
      current.status === "COMPLETED"
    ) {
      return current;
    }

    throw new CameraCaptureJobError(
      "camera_job_state_conflict",
      "Camera capture job changed state during upload.",
    );
  }

  return requireCaptureJob(jobId);
}

/**
 * Transition an uploaded image into server-side processing.
 *
 * Only one server process is allowed to win this transition.
 *
 * This is useful because Gemini/measurement processing must not run twice
 * when the Raspberry Pi retries the upload request.
 *
 * Return:
 *
 * - job != null  -> caller won the processing claim
 * - null         -> another process already claimed/completed it
 */
export async function claimCaptureForProcessing(jobId: string) {
  const now = new Date();
  const result = await prisma.cameraCaptureJob.updateMany({
    where: {
      id: jobId,
      status: "UPLOADED",
    },

    data: {
      status: "PROCESSING",
      expiresAt: calculateProcessingExpiryDate(now),
      updatedAt: now,
    },
  });

  if (result.count !== 1) {
    return null;
  }

  return requireCaptureJob(jobId);
}

/** Keep a live server-side analysis from being recovered as stalled work. */
export async function renewCaptureProcessingLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const renewed = await prisma.cameraCaptureJob.updateMany({
    where: { id: jobId, status: "PROCESSING" },
    data: {
      expiresAt: calculateProcessingExpiryDate(now),
      updatedAt: now,
    },
  });
  return renewed.count === 1;
}

export function captureProcessingHeartbeatMilliseconds(): number {
  return Math.max(5_000, Math.floor(getProcessingTimeoutSeconds() * 1000 / 3));
}

/**
 * Complete the capture after measurement/audit processing succeeds.
 *
 * For MANUAL_SCAN:
 *   resultJson normally stores MeasurementResult.
 *
 * For INVENTORY_AUDIT:
 *   the authoritative audit result normally belongs in BinAudit and this can
 *   be called without result.
 */
export async function completeCaptureJob(
  jobId: string,
  input: CompleteCaptureJobInput = {},
) {
  const now = new Date();

  const resultJson =
    input.result === undefined ? null : JSON.stringify(input.result);

  const updated = await prisma.cameraCaptureJob.updateMany({
    where: {
      id: jobId,

      status: {
        in: ["UPLOADED", "PROCESSING"],
      },
    },

    data: {
      status: "COMPLETED",

      resultJson,

      completedAt: now,

      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    },
  });

  if (updated.count === 1) {
    return requireCaptureJob(jobId);
  }

  const current = await requireCaptureJob(jobId);

  /**
   * Completing twice is harmless/idempotent.
   */
  if (current.status === "COMPLETED") {
    return current;
  }

  throw new CameraCaptureJobError(
    "camera_invalid_job_state",
    `Cannot complete camera job while it is ${current.status}.`,
  );
}

/**
 * Fail a camera capture or its server-side processing.
 *
 * Safe to call more than once:
 * terminal jobs do not reopen.
 */
export async function failCaptureJob(
  jobId: string,
  input: FailCaptureJobInput,
) {
  const errorCode = input.errorCode.trim();

  if (!errorCode) {
    throw new CameraCaptureJobError(
      "camera_invalid_error_code",
      "Camera failure requires an error code.",
    );
  }

  const current = await requireCaptureJob(jobId);

  if (
    current.status === "COMPLETED" ||
    current.status === "FAILED" ||
    current.status === "CANCELLED" ||
    current.status === "EXPIRED"
  ) {
    return current;
  }

  const now = new Date();

  const updated = await prisma.cameraCaptureJob.updateMany({
    where: {
      id: jobId,

      status: {
        in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"],
      },
    },

    data: {
      status: "FAILED",

      errorCode,

      errorMessage: sanitizeErrorMessage(input.errorMessage),

      completedAt: now,
      updatedAt: now,
    },
  });

  if (updated.count === 1) {
    return requireCaptureJob(jobId);
  }

  return requireCaptureJob(jobId);
}

/**
 * Device-scoped failure helper.
 *
 * Use this from:
 *
 * POST /api/camera/device/jobs/[id]/fail
 *
 * so one Raspberry Pi cannot fail another camera's job.
 */
export async function failDeviceCaptureJob(
  jobId: string,
  deviceId: string,
  input: FailCaptureJobInput,
) {
  await requireDeviceCaptureJob(jobId, deviceId);

  return failCaptureJob(jobId, input);
}

/**
 * Browser-facing safe lookup.
 *
 * Don't return the Prisma object directly from an API route.
 */
export async function getCaptureJobStatus(
  jobId: string,
  ownerSessionId?: string,
) {
  const job = ownerSessionId
    ? await requireOwnedCaptureJob(jobId, ownerSessionId)
    : await requireCaptureJob(jobId);

  let queuePosition: number | null = null;
  if (job.status === "CLAIMED") {
    queuePosition = 0;
  } else if (job.status === "PENDING") {
    const [active, ahead] = await Promise.all([
      prisma.cameraCaptureJob.count({
        where: { deviceId: job.deviceId, status: "CLAIMED" },
      }),
      prisma.cameraCaptureJob.count({
        where: {
          deviceId: job.deviceId,
          status: "PENDING",
          OR: [
            { requestedAt: { lt: job.requestedAt } },
            { requestedAt: job.requestedAt, id: { lt: job.id } },
          ],
        },
      }),
    ]);
    queuePosition = active + ahead + 1;
  }

  let result: unknown = null;

  if (job.status === "COMPLETED" && job.resultJson) {
    try {
      result = JSON.parse(job.resultJson);
    } catch {
      /**
       * Stored malformed JSON is a server bug, but we should not crash a
       * read-only dashboard request.
       */
      result = null;
    }
  }

  return {
    id: job.id,

    purpose: job.purpose as CameraCapturePurpose,

    status: job.status as CameraCaptureStatus,

    /** 0 means the Pi owns it now; 1+ is its FIFO waiting position. */
    queuePosition,

    evidenceUrl: job.evidenceUrl,

    imageWidth: job.imageWidth,

    imageHeight: job.imageHeight,

    requestedAt: job.requestedAt.toISOString(),

    claimedAt: job.claimedAt?.toISOString() ?? null,

    capturedAt: job.capturedAt?.toISOString() ?? null,

    uploadedAt: job.uploadedAt?.toISOString() ?? null,

    completedAt: job.completedAt?.toISOString() ?? null,

    expiresAt: job.expiresAt?.toISOString() ?? null,

    error: job.errorCode
      ? {
          code: job.errorCode,
          message: job.errorMessage ?? "Camera capture failed.",
        }
      : null,

    result,
  };
}

/**
 * Convenience helper for routes/UI.
 */
export function isTerminalCaptureStatus(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" || status === "EXPIRED";
}
