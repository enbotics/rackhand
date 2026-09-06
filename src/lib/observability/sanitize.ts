/**
 * The one place trace data is made safe to store and to show (Milestone 12).
 *
 * Everything written to a trace passes through here. Centralising it means the
 * rule is auditable in one file rather than remembered at a dozen call sites —
 * and a new emitter cannot forget it, because the trace service refuses to
 * write metadata that has not been sanitized.
 *
 * THE POSITION IS DENY-BY-DEFAULT. Tool inputs and results are arbitrary
 * shapes that arrive from a language model, from the browser, or from a
 * service; rather than trying to enumerate what is dangerous, this keeps a
 * small set of primitive fields and drops everything else — no nested objects,
 * no arrays of records, no strings past a hard cap. A secret cannot leak
 * through a shape nobody anticipated if the shape itself is not copied.
 *
 * What is never stored, regardless: credentials of any kind, image bytes,
 * system prompts, and private model reasoning.
 */

/** Documented cap on the stored operator request. */
export const MAX_REQUEST_SUMMARY_LENGTH = 500;
/** Cap on any single stored string value. */
export const MAX_VALUE_LENGTH = 200;
/** Cap on a summary sentence. */
export const MAX_SUMMARY_LENGTH = 300;
/** Metadata is a flat bag of small facts, not a document. */
export const MAX_METADATA_KEYS = 12;

/**
 * Key names whose VALUES are never stored, whatever they contain.
 *
 * Matched case-insensitively as substrings, so `awsSecretAccessKey`,
 * `AWS_SECRET_ACCESS_KEY` and `x-api-key` are all caught.
 */
const REDACTED_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "credential",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "session",
  "bearer",
  "aws_",
  "aws access",
  "awsaccess",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "connectionstring",
  "connection_string",
  "database_url",
  "databaseurl",
  "gemini",
  "signature",
  "sig",
];

/**
 * Value shapes that are never stored even under an innocent key.
 *
 * A base64 image is the one that matters most here: `imageDataUrl` is an
 * obvious name to redact, but a model could put the same bytes under `data`
 * or `frame`, so the VALUE is checked too.
 */
const FORBIDDEN_VALUE_PATTERNS: RegExp[] = [
  /^data:/i, // data: URLs, including data:image/jpeg;base64,...
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /^Bearer\s+/i,
  /^AIza[0-9A-Za-z_-]{10,}/, // Google/Gemini API key
  /^file:\/\//i, // database connection URL
  /^(postgres|postgresql|mysql|mongodb)(\+srv)?:\/\//i,
];

/** Very long unbroken tokens are far more likely to be a payload than a fact. */
const LONG_OPAQUE_TOKEN = /[A-Za-z0-9+/=_-]{120,}/;

export const REDACTED = "[redacted]";

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isForbiddenValue(value: string): boolean {
  return (
    FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    LONG_OPAQUE_TOKEN.test(value)
  );
}

/** Truncates without pretending the rest was never there. */
export function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Sanitizes one value for storage.
 *
 * Returns `undefined` for anything that should not be kept at all, so the
 * caller drops the key rather than writing a placeholder for every nested
 * object the model happened to send.
 */
function sanitizeValue(key: string, value: unknown): string | number | boolean | undefined {
  if (isRedactedKey(key)) return REDACTED;

  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return undefined;

  if (typeof value === "string") {
    if (value === "") return undefined;
    if (isForbiddenValue(value)) return REDACTED;
    return truncate(value, MAX_VALUE_LENGTH);
  }

  // Arrays of primitives compress to a short readable list; anything deeper is
  // dropped. A trace is a timeline, not a document store.
  if (Array.isArray(value)) {
    const items = value
      .filter((item) => typeof item === "string" || typeof item === "number")
      .slice(0, 5)
      .map(String);
    if (items.length === 0) return undefined;
    const rendered = items.join(", ");
    return isForbiddenValue(rendered) ? REDACTED : truncate(rendered, MAX_VALUE_LENGTH);
  }

  // Objects are deliberately not walked. See the module comment.
  return undefined;
}

/**
 * Sanitizes a flat bag of metadata.
 *
 * Nested structures are dropped rather than flattened: every emitter in this
 * codebase already knows exactly which few fields are worth recording, so
 * anything nested is by definition something nobody chose to record.
 */
export function sanitizeMetadata(input: unknown): Record<string, string | number | boolean> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;

  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(output).length >= MAX_METADATA_KEYS) break;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : null;
}

/** The operator's own words, bounded. Never a system prompt or model output. */
export function sanitizeRequestSummary(message: unknown): string {
  if (typeof message !== "string" || message.trim() === "") return "(no request text)";
  const text = truncate(message, MAX_REQUEST_SUMMARY_LENGTH);
  return isForbiddenValue(text) ? REDACTED : text;
}

/** One readable sentence for a timeline row. */
export function sanitizeSummary(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "") return "";
  const summary = truncate(text, MAX_SUMMARY_LENGTH);
  return isForbiddenValue(summary) ? REDACTED : summary;
}

/**
 * An error as an operator may see it.
 *
 * The message is truncated and scanned like any other value, and the stack is
 * dropped entirely — a stack trace in a browser response is both noise and a
 * disclosure.
 */
export function sanitizeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? truncate(code, 60) : error.name || "error",
      message: sanitizeSummary(error.message) || "The operation failed.",
    };
  }
  return { code: "error", message: "The operation failed." };
}

/**
 * A scan reduced to the facts worth tracing.
 *
 * The image never travels with a ScanResult in this system, but the explicit
 * field list is what guarantees it: a future field on the contract cannot
 * silently start being persisted.
 */
export function sanitizeScanResult(scan: unknown): Record<string, string | number | boolean> | null {
  if (typeof scan !== "object" || scan === null) return null;
  const value = scan as {
    scanId?: unknown;
    object?: { detectedName?: unknown };
    dimensions?: { lengthMM?: unknown; widthMM?: unknown; heightMM?: unknown };
    quality?: { dimensionConfidence?: unknown; calibrationRmsPixels?: unknown };
  };

  const dimensions = value.dimensions;
  return sanitizeMetadata({
    scanId: value.scanId,
    detectedName: value.object?.detectedName,
    dimensionsMM:
      dimensions && typeof dimensions.lengthMM === "number"
        ? `${dimensions.lengthMM} × ${dimensions.widthMM} × ${dimensions.heightMM ?? "?"}`
        : undefined,
    dimensionConfidence: value.quality?.dimensionConfidence,
    calibrationRmsPixels: value.quality?.calibrationRmsPixels,
  });
}
