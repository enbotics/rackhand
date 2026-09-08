/**
 * The observability contract (Milestone 12).
 *
 * Types only, no runtime dependency on the Strands SDK or Prisma, so the
 * dashboard can render a timeline without pulling either into the browser —
 * same rule as scan-types.ts and workflow-types.ts.
 *
 * OBSERVATIONAL, NOT AUTHORITATIVE. Everything here describes what happened.
 * Nothing may read a trace to decide warehouse state: Inventory, Bin, Movement
 * and Part remain the only sources of truth, and a trace that disagrees with
 * them is a bug in the trace, never a change to the warehouse.
 *
 * WHAT, NEVER WHY. A trace says "search_inventory ran and found BRG-6204 in
 * B2-01". It never says what the model privately deliberated. Chain-of-thought,
 * scratchpads, reasoning tokens and system prompts are not stored and not
 * displayed.
 */

/**
 * A whole agent request's outcome.
 *
 * BLOCKED and DENIED are separate from FAILED on purpose: "the catalog match
 * needs a human" and "the operator said no" are correct, healthy outcomes, and
 * an operator scanning a list of runs should not have to read the detail to
 * tell them apart from a gantry fault.
 */
export const TRACE_STATUSES = [
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "DENIED",
  "EXPIRED",
] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** Terminal statuses. The dashboard stops polling once a trace reaches one. */
export const TERMINAL_TRACE_STATUSES: readonly TraceStatus[] = [
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "DENIED",
  "EXPIRED",
];

export function isTerminalTraceStatus(status: TraceStatus): boolean {
  return TERMINAL_TRACE_STATUSES.includes(status);
}

/**
 * The event types this architecture actually produces.
 *
 * Deliberately shorter than the menu in the brief: an event that nothing emits
 * is a lie waiting to happen. Notably there is no MOVEMENT_RUNNING or
 * GANTRY_STARTED — the services run those transitions synchronously inside one
 * call, so observing a "started" the trace can never see the end of would add
 * noise, not information. Each is derived only from a committed result.
 */
export const TRACE_EVENT_TYPES = [
  "AGENT_STARTED",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "APPROVAL_REQUIRED",
  "APPROVAL_APPROVED",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "CATALOG_RESOLUTION_REQUIRED",
  "CATALOG_RESOLUTION_CONFIRMED",
  "CATALOG_RESOLUTION_REJECTED",
  "GRAPH_STARTED",
  "GRAPH_STEP_COMPLETED",
  "GRAPH_STEP_BLOCKED",
  "GRAPH_STEP_FAILED",
  "GRAPH_STEP_SKIPPED",
  "GRAPH_COMPLETED",
  "GRAPH_BLOCKED",
  "GRAPH_FAILED",
  "MOVEMENT_COMPLETED",
  "MOVEMENT_FAILED",
  "GANTRY_COMPLETED",
  "GANTRY_FAILED",
  "INVENTORY_UPDATED",
  "BIN_STATUS_UPDATED",
  "AGENT_COMPLETED",
  "AGENT_FAILED",
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const TRACE_EVENT_STATUSES = [
  "STARTED",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "INFO",
] as const;
export type TraceEventStatus = (typeof TRACE_EVENT_STATUSES)[number];

/**
 * The visual grouping the dashboard uses. Derived from the event type, so a
 * new event type cannot land on screen without a category.
 */
export const TRACE_CATEGORIES = [
  "AGENT",
  "TOOL",
  "HUMAN",
  "GRAPH",
  "GANTRY",
  "WAREHOUSE",
  "ERROR",
] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

const CATEGORY_BY_TYPE: Record<TraceEventType, TraceCategory> = {
  AGENT_STARTED: "AGENT",
  AGENT_COMPLETED: "AGENT",
  AGENT_FAILED: "ERROR",
  TOOL_STARTED: "TOOL",
  TOOL_COMPLETED: "TOOL",
  TOOL_FAILED: "ERROR",
  APPROVAL_REQUIRED: "HUMAN",
  APPROVAL_APPROVED: "HUMAN",
  APPROVAL_DENIED: "HUMAN",
  APPROVAL_EXPIRED: "HUMAN",
  CATALOG_RESOLUTION_REQUIRED: "HUMAN",
  CATALOG_RESOLUTION_CONFIRMED: "HUMAN",
  CATALOG_RESOLUTION_REJECTED: "HUMAN",
  GRAPH_STARTED: "GRAPH",
  GRAPH_STEP_COMPLETED: "GRAPH",
  GRAPH_STEP_BLOCKED: "GRAPH",
  GRAPH_STEP_FAILED: "GRAPH",
  GRAPH_STEP_SKIPPED: "GRAPH",
  GRAPH_COMPLETED: "GRAPH",
  GRAPH_BLOCKED: "GRAPH",
  GRAPH_FAILED: "GRAPH",
  MOVEMENT_COMPLETED: "WAREHOUSE",
  MOVEMENT_FAILED: "WAREHOUSE",
  GANTRY_COMPLETED: "GANTRY",
  GANTRY_FAILED: "GANTRY",
  INVENTORY_UPDATED: "WAREHOUSE",
  BIN_STATUS_UPDATED: "WAREHOUSE",
};

export function traceCategory(type: string): TraceCategory {
  return CATEGORY_BY_TYPE[type as TraceEventType] ?? "AGENT";
}

/** One row of the operator-facing timeline. */
export interface TraceEventView {
  /** Display order within the trace. Never database row order. */
  sequence: number;
  type: string;
  category: TraceCategory;
  status: TraceEventStatus;
  /** Tool name, graph node id, or null. */
  name: string | null;
  /** One readable sentence, built from warehouse facts. */
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Small sanitized detail, shown only when a row is expanded. */
  metadata: Record<string, unknown> | null;
}

/** Small, stable subset of the Strands AgentResult metrics. All optional. */
export interface TraceMetrics {
  modelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelLatencyMs: number | null;
}

export interface TraceView {
  traceId: string;
  status: TraceStatus;
  /** The operator's own words, truncated. Never a prompt or model output. */
  requestSummary: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: { code: string; message: string } | null;
  metrics: TraceMetrics;
  events: TraceEventView[];
}

/** One row in the recent-runs list. No events, so the list stays cheap. */
export interface TraceSummaryView {
  traceId: string;
  status: TraceStatus;
  requestSummary: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  eventCount: number;
}
