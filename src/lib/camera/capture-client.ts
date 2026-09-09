"use client";

export type CameraCaptureStatus =
  | "PENDING"
  | "CLAIMED"
  | "UPLOADED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED";

export interface CameraCaptureJobView<TResult = unknown> {
  captureJobId: string;

  purpose: string;

  status: CameraCaptureStatus;

  evidenceUrl: string | null;

  imageWidth: number | null;

  imageHeight: number | null;

  requestedAt: string;

  claimedAt: string | null;

  capturedAt: string | null;

  uploadedAt: string | null;

  completedAt: string | null;

  result: TResult | null;

  error: {
    code: string;
    message: string;
  } | null;
}

interface CreateCaptureResponse {
  captureJobId: string;
  status: CameraCaptureStatus;
  requestedAt: string;
  expiresAt: string;
}

export class CameraCaptureClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CameraCaptureClientError";
  }
}

export async function createCameraCapture(): Promise<CreateCaptureResponse> {
  const response = await fetch("/api/camera/captures", {
    method: "POST",
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = body?.error ?? {};

    throw new CameraCaptureClientError(
      typeof error.code === "string"
        ? error.code
        : "camera_capture_create_failed",

      typeof error.message === "string"
        ? error.message
        : "Could not request a camera capture.",
    );
  }

  return body as CreateCaptureResponse;
}

export async function getCameraCapture<TResult = unknown>(
  captureJobId: string,
): Promise<CameraCaptureJobView<TResult>> {
  const response = await fetch(
    `/api/camera/captures/${encodeURIComponent(captureJobId)}`,
    {
      cache: "no-store",
    },
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = body?.error ?? {};

    throw new CameraCaptureClientError(
      typeof error.code === "string"
        ? error.code
        : "camera_capture_status_failed",

      typeof error.message === "string"
        ? error.message
        : "Could not read camera capture status.",
    );
  }

  return body as CameraCaptureJobView<TResult>;
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);

    if (!signal) {
      return;
    }

    const abort = () => {
      window.clearTimeout(timer);

      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, {
      once: true,
    });
  });
}

export async function waitForCameraCapture<TResult = unknown>(
  captureJobId: string,
  options?: {
    signal?: AbortSignal;

    pollIntervalMs?: number;

    timeoutMs?: number;

    onStatus?: (job: CameraCaptureJobView<TResult>) => void;
  },
): Promise<CameraCaptureJobView<TResult>> {
  const {
    signal,
    pollIntervalMs = 1000,
    timeoutMs = 120_000,
    onStatus,
  } = options ?? {};

  const startedAt = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const job = await getCameraCapture<TResult>(captureJobId);

    onStatus?.(job);

    switch (job.status) {
      case "COMPLETED":
        return job;

      case "FAILED":
        throw new CameraCaptureClientError(
          job.error?.code ?? "camera_capture_failed",

          job.error?.message ?? "Camera capture failed.",
        );

      case "EXPIRED":
        throw new CameraCaptureClientError(
          "camera_job_expired",
          "The camera capture request expired.",
        );
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new CameraCaptureClientError(
        "camera_capture_timeout",
        "Timed out waiting for the camera.",
      );
    }

    await sleep(pollIntervalMs, signal);
  }
}
