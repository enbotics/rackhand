/**
 * How warehouse state is LABELLED for an operator (Milestone 10).
 *
 * Presentation only. Nothing here decides anything: it turns a status the
 * server already computed into a word, a symbol and a tone. No availability
 * rule, no quantity arithmetic, no matching threshold — those live in the
 * warehouse services, and duplicating any of them here would create a second
 * opinion the operator could act on.
 *
 * Pure and client-safe (no imports beyond the shared status vocabularies), so
 * both the dashboard and its tests can use it directly.
 *
 * EVERY status carries a `symbol` as well as a `tone`. Colour alone is not a
 * status: a red bin and a green bin look identical to a colour-blind operator
 * and to a projector at the back of a room.
 */
import type { BinStatus, MovementStatus } from "./types";
import type { GantryState } from "@/lib/gantry/types";
import type { InventoryRowView } from "./dashboard-types";
import type { WorkflowStepStatus } from "./graphs/workflow-types";
import type { TraceCategory, TraceEventStatus, TraceStatus } from "@/lib/observability/types";

/** Semantic tones. The UI maps these to colours; this module never names one. */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "muted";

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /** Redundant encoding so status is legible without colour. */
  symbol: string;
}

export const BIN_STATUS_PRESENTATION: Record<BinStatus, StatusPresentation> = {
  AVAILABLE: { label: "AVAILABLE", tone: "ok", symbol: "○" },
  OCCUPIED: { label: "OCCUPIED", tone: "accent", symbol: "●" },
  RESERVED: { label: "RESERVED", tone: "warn", symbol: "◐" },
  DISABLED: { label: "DISABLED", tone: "muted", symbol: "⊘" },
};

export const MOVEMENT_STATUS_PRESENTATION: Record<MovementStatus, StatusPresentation> = {
  PENDING: { label: "PENDING", tone: "neutral", symbol: "•" },
  VALIDATED: { label: "VALIDATED", tone: "neutral", symbol: "•" },
  RUNNING: { label: "RUNNING", tone: "accent", symbol: "▸" },
  COMPLETED: { label: "COMPLETED", tone: "ok", symbol: "✓" },
  FAILED: { label: "FAILED", tone: "danger", symbol: "×" },
  CANCELLED: { label: "CANCELLED", tone: "muted", symbol: "–" },
};

export const GANTRY_STATE_PRESENTATION: Record<GantryState, StatusPresentation> = {
  OFFLINE: { label: "OFFLINE", tone: "muted", symbol: "⊘" },
  IDLE: { label: "IDLE", tone: "ok", symbol: "○" },
  HOMING: { label: "HOMING", tone: "accent", symbol: "▸" },
  MOVING: { label: "MOVING", tone: "accent", symbol: "▸" },
  PICKING: { label: "PICKING", tone: "accent", symbol: "▸" },
  DROPPING: { label: "DROPPING", tone: "accent", symbol: "▸" },
  ERROR: { label: "ERROR", tone: "danger", symbol: "×" },
};

/**
 * Strands graph workflow steps (Milestone 11).
 *
 * BLOCKED and FAILED are drawn differently on purpose. "A human must identify
 * this part" and "the gantry dropped it" are both stops, but only one of them
 * is a fault, and an operator reacts to them differently.
 */
export const WORKFLOW_STEP_PRESENTATION: Record<WorkflowStepStatus, StatusPresentation> = {
  PENDING: { label: "PENDING", tone: "muted", symbol: "○" },
  RUNNING: { label: "RUNNING", tone: "accent", symbol: "●" },
  COMPLETED: { label: "COMPLETED", tone: "ok", symbol: "✓" },
  BLOCKED: { label: "BLOCKED", tone: "warn", symbol: "!" },
  FAILED: { label: "FAILED", tone: "danger", symbol: "✕" },
  SKIPPED: { label: "SKIPPED", tone: "muted", symbol: "○" },
};

/**
 * Trace event categories (Milestone 12).
 *
 * The label is the word an operator reads; the symbol is the second,
 * non-colour encoding. A timeline is scanned quickly, so a row has to say what
 * kind of thing it is before anyone reads the sentence.
 */
export const TRACE_CATEGORY_PRESENTATION: Record<TraceCategory, StatusPresentation> = {
  AGENT: { label: "AGENT", tone: "accent", symbol: "◆" },
  TOOL: { label: "TOOL", tone: "neutral", symbol: "▸" },
  HUMAN: { label: "HUMAN", tone: "warn", symbol: "☑" },
  GRAPH: { label: "GRAPH", tone: "accent", symbol: "⋯" },
  GANTRY: { label: "GANTRY", tone: "neutral", symbol: "⚙" },
  WAREHOUSE: { label: "WAREHOUSE", tone: "ok", symbol: "▤" },
  ERROR: { label: "ERROR", tone: "danger", symbol: "✕" },
};

export const TRACE_EVENT_STATUS_PRESENTATION: Record<TraceEventStatus, StatusPresentation> = {
  STARTED: { label: "STARTED", tone: "neutral", symbol: "●" },
  COMPLETED: { label: "OK", tone: "ok", symbol: "✓" },
  BLOCKED: { label: "BLOCKED", tone: "warn", symbol: "!" },
  FAILED: { label: "FAILED", tone: "danger", symbol: "✕" },
  INFO: { label: "SKIPPED", tone: "muted", symbol: "○" },
};

export const TRACE_STATUS_PRESENTATION: Record<TraceStatus, StatusPresentation> = {
  RUNNING: { label: "RUNNING", tone: "accent", symbol: "●" },
  WAITING_FOR_APPROVAL: { label: "AWAITING APPROVAL", tone: "warn", symbol: "!" },
  COMPLETED: { label: "COMPLETED", tone: "ok", symbol: "✓" },
  BLOCKED: { label: "BLOCKED", tone: "warn", symbol: "!" },
  FAILED: { label: "FAILED", tone: "danger", symbol: "✕" },
  DENIED: { label: "DENIED", tone: "muted", symbol: "–" },
  EXPIRED: { label: "EXPIRED", tone: "muted", symbol: "–" },
};

/** "84 ms", "1.4 s" — durations an operator reads, not raw milliseconds. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Wall-clock time of day, to the second, for a timeline row. */
export function formatClockSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * How the operator sees the identity of the current scan.
 *
 * HUMAN_CONFIRMED is deliberately its OWN state and not a second spelling of
 * MATCHED. The deterministic matcher never turned this scan into a match — a
 * person took responsibility for it — and the dashboard must keep saying so,
 * because that difference is exactly what an audit asks about later.
 */
export type ScanIdentityStatus =
  | "MATCHED"
  | "AMBIGUOUS"
  | "NO_MATCH"
  | "INVALID_SCAN"
  | "HUMAN_CONFIRMED";

export const SCAN_IDENTITY_PRESENTATION: Record<ScanIdentityStatus, StatusPresentation> = {
  MATCHED: { label: "MATCHED", tone: "ok", symbol: "✓" },
  HUMAN_CONFIRMED: { label: "HUMAN CONFIRMED", tone: "accent", symbol: "☑" },
  AMBIGUOUS: { label: "AMBIGUOUS", tone: "warn", symbol: "!" },
  NO_MATCH: { label: "NO MATCH", tone: "danger", symbol: "×" },
  INVALID_SCAN: { label: "INVALID SCAN", tone: "danger", symbol: "⚠" },
};

/** One line of provenance, so a human decision never reads as a measurement. */
export const IDENTITY_PROVENANCE: Record<ScanIdentityStatus, string | null> = {
  MATCHED: "Identified by the deterministic catalog matcher.",
  HUMAN_CONFIRMED: "Identified by an operator, not by the matcher.",
  AMBIGUOUS: "The matcher could not choose between these parts.",
  NO_MATCH: "No catalog part is close enough to this scan.",
  INVALID_SCAN: "This scan is not usable as warehouse evidence.",
};

/**
 * The one place the current scan's identity state is decided for display.
 *
 * Kept as a pure function, and kept OUT of the components, because the rule it
 * encodes matters: a human confirmation is never rendered as a match. The
 * deterministic matcher said AMBIGUOUS and still says AMBIGUOUS — what changed
 * is that a person took responsibility, and HUMAN_CONFIRMED is how the
 * dashboard says so. Collapsing the two would erase the provenance the
 * warehouse deliberately records.
 */
export function deriveScanIdentity(input: {
  /** False when the measurement did not satisfy the ScanResult contract. */
  hasValidScan: boolean;
  /** The deterministic matcher's verdict, or null before it has run. */
  matchStatus: "MATCHED" | "AMBIGUOUS" | "NO_MATCH" | null;
  /** An operator confirmed the identity of THIS scan (Milestone 9). */
  humanConfirmed: boolean;
}): ScanIdentityStatus | null {
  if (!input.hasValidScan) return "INVALID_SCAN";
  if (input.humanConfirmed) return "HUMAN_CONFIRMED";
  return input.matchStatus;
}

/**
 * Operator guidance for a failed scan, keyed by the error code
 * /api/measure returns. The server's own sentence is shown alongside it; this
 * adds what to DO, which an error code cannot say.
 *
 * A stack trace is never surfaced — see the `?? ` fallback, which is
 * deliberately vague rather than leaking whatever the server hit.
 */
const MEASURE_GUIDANCE: Record<string, string> = {
  mat_not_detected:
    "Make sure all four corner QR codes of the calibration mat are visible, flat and unobstructed, then scan again.",
  calibration_failed:
    "The mat was found but the fit failed. Flatten the mat, reduce glare, and scan again from directly overhead.",
  no_object_detected: "Place exactly one part inside the calibration area and scan again.",
  multiple_objects: "More than one object is on the mat. Leave a single part in frame and scan again.",
  validation_failed: "The captured frame was rejected. Restart the preview and scan again.",
  malformed_request: "The captured frame was rejected. Restart the preview and scan again.",
  internal_error: "The measurement service could not complete the scan. Try again in a moment.",
};

export interface ScanFailure {
  /** Short operator-facing headline. */
  title: string;
  /** What to do about it. */
  guidance: string;
}

export function describeMeasureFailure(code: unknown, message: unknown): ScanFailure {
  const key = typeof code === "string" ? code : "";
  return {
    title:
      typeof message === "string" && message.trim() !== ""
        ? message
        : "The scan could not be measured.",
    guidance: MEASURE_GUIDANCE[key] ?? "Check the mat and the part, then scan again.",
  };
}

/**
 * Lightweight inventory search over data the server already returned.
 *
 * A filter, not a query: it never asks the warehouse a different question, so
 * an empty result means "nothing on screen matches", never "no stock".
 */
export function filterInventory(rows: InventoryRowView[], query: string): InventoryRowView[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) =>
    [row.sku, row.canonicalName, row.category ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/** "B2-01" for one bin, "B1-02 (1), B2-01 (2)" when a part is split across several. */
export function formatLocations(locations: Array<{ binCode: string; quantity: number }>): string {
  if (locations.length === 0) return "—";
  if (locations.length === 1) return locations[0].binCode;
  return locations.map((location) => `${location.binCode} (${location.quantity})`).join(", ");
}

/** Local wall-clock time for a movement row. Formatted in the operator's timezone. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatMM(value: number | null): string {
  if (value === null) return "?";
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
