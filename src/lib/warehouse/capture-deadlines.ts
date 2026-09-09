const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 5 * 60;

function timeoutMilliseconds(
  environmentName: string,
  fallbackSeconds: number,
): number {
  const raw = process.env[environmentName] ?? String(fallbackSeconds);
  const seconds = Number(raw);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${environmentName} must be a positive number.`);
  }

  return seconds * 1000;
}

/** Deadline used only while Gemini is analyzing an already-uploaded frame. */
export function captureProcessingDeadline(now = new Date()): Date {
  return new Date(
    now.getTime() + timeoutMilliseconds(
      "CAMERA_PROCESSING_TIMEOUT_SECONDS",
      DEFAULT_PROCESSING_TIMEOUT_SECONDS,
    ),
  );
}
