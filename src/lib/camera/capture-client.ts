"use client";

export type CameraCaptureStatus =
  | "PENDING"
  | "CLAIMED"
  | "UPLOADED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
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

  expiresAt: string | null;

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
  expiresAt: string | null;
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

export async function waitForCameraCapture<TResult = unknown>(
  captureJobId: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onStatus?: (job: CameraCaptureJobView<TResult>) => void;
  },
): Promise<CameraCaptureJobView<TResult>> {
  const {
    signal,
    timeoutMs,
    onStatus,
  } = options ?? {};

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const source = new EventSource(
      `/api/camera/captures/${encodeURIComponent(captureJobId)}/events`,
    );
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      source.close();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Aborted", "AbortError"));
    const timer = timeoutMs === undefined ? undefined : window.setTimeout(() => {
      fail(new CameraCaptureClientError(
        "camera_capture_timeout",
        "Timed out waiting for the camera Realtime stream.",
      ));
    }, timeoutMs);

    source.addEventListener("status", (event) => {
      let job: CameraCaptureJobView<TResult>;
      try {
        job = JSON.parse((event as MessageEvent<string>).data) as CameraCaptureJobView<TResult>;
      } catch {
        fail(new CameraCaptureClientError(
          "camera_status_invalid",
          "The camera Realtime stream returned invalid status data.",
        ));
        return;
      }

      onStatus?.(job);
      if (job.status === "COMPLETED") {
        cleanup();
        resolve(job);
      } else if (job.status === "FAILED") {
        fail(new CameraCaptureClientError(
          job.error?.code ?? "camera_capture_failed",
          job.error?.message ?? "Camera capture failed.",
        ));
      } else if (job.status === "CANCELLED") {
        fail(new CameraCaptureClientError(
          job.error?.code ?? "camera_capture_cancelled",
          job.error?.message ?? "Camera capture was cancelled.",
        ));
      } else if (job.status === "EXPIRED") {
        fail(new CameraCaptureClientError(
          "camera_job_expired",
          "The camera capture request expired.",
        ));
      }
    });
    source.addEventListener("stream-error", (event) => {
      let message = "The camera Realtime status stream failed.";
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
        if (payload.message) message = payload.message;
      } catch { /* Use the safe fallback. */ }
      fail(new CameraCaptureClientError("camera_status_stream_failed", message));
    });
    // Native EventSource errors reconnect automatically. The durable current
    // status is emitted again after every successful reconnection.
    signal?.addEventListener("abort", abort, { once: true });
  });
}
