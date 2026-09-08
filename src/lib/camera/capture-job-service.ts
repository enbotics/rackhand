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
 */
export const CAMERA_CAPTURE_PURPOSES = [
  "MANUAL_SCAN",
  "INVENTORY_AUDIT",
  "RECOUNT",
] as const;

export type CameraCapturePurpose = (typeof CAMERA_CAPTURE_PURPOSES)[number];

export const CAMERA_CAPTURE_STATUSES = [
  "PENDING",
  "CLAIMED",
  "UPLOADED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
] as const;

export type CameraCaptureStatus = (typeof CAMERA_CAPTURE_STATUSES)[number];

const DEFAULT_CAPTURE_TIMEOUT_SECONDS = 30;

/**
 * Keep this small.
 *
 * Raspberry Pi polling should never hold a DB transaction open while
 * waiting for hardware/network activity.
 */
const MAX_CLAIM_ATTEMPTS = 3;

export interface CreateCaptureJobInput {
  purpose: CameraCapturePurpose;

  /**
   * Optional audit relation.
   *
   * Required for INVENTORY_AUDIT / RECOUNT once those flows are wired.
   */
  binAuditId?: string | null;

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

function calculateExpiryDate(now = new Date()): Date {
  const timeoutSeconds = getCaptureTimeoutSeconds();

  return new Date(now.getTime() + timeoutSeconds * 1000);
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
      purpose: input.purpose,
      deviceId,

      status: "PENDING",

      binAuditId: input.binAuditId ?? null,

      requestedAt: now,
      expiresAt: calculateExpiryDate(now),
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

/**
 * Mark stale non-terminal jobs EXPIRED.
 *
 * This is intentionally callable from request paths; no background worker
 * is required for the MVP.
 */
export async function expireStaleCaptureJobs(
  now = new Date(),
): Promise<number> {
  const result = await prisma.cameraCaptureJob.updateMany({
    where: {
      expiresAt: {
        lte: now,
      },

      status: {
        in: ["PENDING", "CLAIMED"],
      },
    },

    data: {
      status: "EXPIRED",
      completedAt: now,
      errorCode: "camera_capture_timeout",
      errorMessage:
        "The camera capture request expired before an image was received.",
    },
  });

  return result.count;
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

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const candidate = await prisma.cameraCaptureJob.findFirst({
      where: {
        deviceId: normalizedDeviceId,

        status: "PENDING",

        expiresAt: {
          gt: now,
        },
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
        expiresAt: {
          gt: claimedAt,
        },
      },

      data: {
        status: "CLAIMED",
        claimedAt,
        expiresAt: captureDeadline,
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

  if (job.expiresAt <= now) {
    await prisma.cameraCaptureJob.updateMany({
      where: {
        id: jobId,
        status: "CLAIMED",
      },

      data: {
        status: "EXPIRED",
        completedAt: now,
        errorCode: "camera_capture_timeout",
        errorMessage:
          "The camera capture request expired before upload completed.",
      },
    });

    throw new CameraCaptureJobError(
      "camera_job_expired",
      "The camera capture job has expired.",
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
  const result = await prisma.cameraCaptureJob.updateMany({
    where: {
      id: jobId,
      status: "UPLOADED",
    },

    data: {
      status: "PROCESSING",
    },
  });

  if (result.count !== 1) {
    return null;
  }

  return requireCaptureJob(jobId);
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
export async function getCaptureJobStatus(jobId: string) {
  const job = await requireCaptureJob(jobId);

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

    evidenceUrl: job.evidenceUrl,

    imageWidth: job.imageWidth,

    imageHeight: job.imageHeight,

    requestedAt: job.requestedAt.toISOString(),

    claimedAt: job.claimedAt?.toISOString() ?? null,

    capturedAt: job.capturedAt?.toISOString() ?? null,

    uploadedAt: job.uploadedAt?.toISOString() ?? null,

    completedAt: job.completedAt?.toISOString() ?? null,

    expiresAt: job.expiresAt.toISOString(),

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
  return status === "COMPLETED" || status === "FAILED" || status === "EXPIRED";
}
