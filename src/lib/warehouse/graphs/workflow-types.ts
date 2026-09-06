/**
 * The application-level contract for a warehouse workflow run (Milestone 11).
 *
 * Types only, no runtime dependency on the Strands SDK, so a browser panel can
 * render workflow progress without pulling the orchestrator — or AWS, or
 * Prisma — into the client bundle. Same rule as scan-types.ts.
 *
 * DELIBERATELY INDEPENDENT OF STRANDS INTERNALS. A raw `MultiAgentResult`
 * carries node content blocks, token usage and error objects; none of that is
 * warehouse truth and some of it should never leave the server. The graph
 * runner translates it into the shapes below, and only these cross an API
 * boundary.
 *
 * This is workflow state, NOT tracing. There are no durations beyond
 * start/finish stamps, no token counts, no model events and no prompts —
 * Milestone 12 owns observability.
 */
import type { PutawayResult } from "../putaway-types";
import type { RetrievalResult } from "../retrieval-types";

export type WorkflowKind = "PUTAWAY" | "RETRIEVAL";

/**
 * Per-node status as the operator sees it.
 *
 * `BLOCKED` is not `FAILED`. A node that stops the workflow because the
 * catalog match is ambiguous did its job correctly — the workflow is what
 * stopped, not the node. Collapsing the two would make a routine "a human must
 * decide this" indistinguishable from a machine fault.
 *
 * `SKIPPED` is a node that never ran because an earlier stage stopped.
 */
export const WORKFLOW_STEP_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "SKIPPED",
] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

/**
 * One node's outcome.
 *
 * `summary` is written by the node from structured warehouse facts — never
 * model output, and never chain-of-thought. Nothing here may carry a prompt,
 * a credential, an image or private reasoning.
 */
export interface WorkflowStepResult {
  nodeId: string;
  /** Stable operator-facing label, e.g. "Resolve identity". */
  label: string;
  status: WorkflowStepStatus;
  /** ISO-8601. Absent while the step has not started. */
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  /** A machine-readable reason, present on BLOCKED and FAILED. */
  reason?: string;
}

export type WarehouseGraphResult =
  | {
      status: "COMPLETED";
      workflow: WorkflowKind;
      /** This workflow run's own id — distinct from the movement and the machine operation. */
      operationId: string;
      movementId: string;
      gantryOperationId: string;
      steps: WorkflowStepResult[];
    }
  | {
      status: "BLOCKED";
      workflow: WorkflowKind;
      /** Which gate stopped it, e.g. "catalog_match_ambiguous". */
      reason: string;
      /** Operator-facing sentence. Safe to display. */
      message: string;
      operationId: string;
      steps: WorkflowStepResult[];
    }
  | {
      status: "FAILED";
      workflow: WorkflowKind;
      reason: string;
      message: string;
      operationId: string;
      /** Preserved for reconciliation when the failure happened after a movement existed. */
      movementId?: string;
      gantryOperationId?: string;
      steps: WorkflowStepResult[];
    };

/**
 * What a graph run hands back to its caller.
 *
 * `result` is the UNCHANGED Milestone 7/8 service result. The Strands tool
 * still returns exactly that to the agent, so wrapping the services in a graph
 * changed no agent-visible contract and no prompt. `graph` is the new
 * orchestration view, for the operator and for Milestone 12.
 */
export interface PutawayGraphRun {
  graph: WarehouseGraphResult;
  result: PutawayResult;
}

export interface RetrievalGraphRun {
  graph: WarehouseGraphResult;
  result: RetrievalResult;
}

/* ------------------------------------------------------------- node ids */

/**
 * Stable node ids. They appear in graph topology, in step results and (from
 * Milestone 12) in traces, so they are declared once and never derived from a
 * label an editor might reword.
 */
export const PUTAWAY_NODE_IDS = {
  validate: "putaway_validate",
  identity: "putaway_identity",
  destination: "putaway_destination",
  preflight: "putaway_preflight",
  execute: "putaway_execute",
  verify: "putaway_verify",
} as const;

export const RETRIEVAL_NODE_IDS = {
  validate: "retrieval_validate",
  part: "retrieval_part",
  inventory: "retrieval_inventory",
  source: "retrieval_source",
  preflight: "retrieval_preflight",
  execute: "retrieval_execute",
  verify: "retrieval_verify",
} as const;

/** Execution order, used to report SKIPPED steps and to draw the dashboard. */
export const PUTAWAY_NODE_ORDER: readonly string[] = [
  PUTAWAY_NODE_IDS.validate,
  PUTAWAY_NODE_IDS.identity,
  PUTAWAY_NODE_IDS.destination,
  PUTAWAY_NODE_IDS.preflight,
  PUTAWAY_NODE_IDS.execute,
  PUTAWAY_NODE_IDS.verify,
];

export const RETRIEVAL_NODE_ORDER: readonly string[] = [
  RETRIEVAL_NODE_IDS.validate,
  RETRIEVAL_NODE_IDS.part,
  RETRIEVAL_NODE_IDS.inventory,
  RETRIEVAL_NODE_IDS.source,
  RETRIEVAL_NODE_IDS.preflight,
  RETRIEVAL_NODE_IDS.execute,
  RETRIEVAL_NODE_IDS.verify,
];

/** Operator-facing labels. Client-safe: no ids leak warehouse internals. */
export const WORKFLOW_NODE_LABELS: Record<string, string> = {
  [PUTAWAY_NODE_IDS.validate]: "Validate scan",
  [PUTAWAY_NODE_IDS.identity]: "Resolve identity",
  [PUTAWAY_NODE_IDS.destination]: "Resolve destination",
  [PUTAWAY_NODE_IDS.preflight]: "Preflight",
  [PUTAWAY_NODE_IDS.execute]: "Execute putaway",
  [PUTAWAY_NODE_IDS.verify]: "Verify",
  [RETRIEVAL_NODE_IDS.validate]: "Validate request",
  [RETRIEVAL_NODE_IDS.part]: "Resolve part",
  [RETRIEVAL_NODE_IDS.inventory]: "Check inventory",
  [RETRIEVAL_NODE_IDS.source]: "Select source bin",
  [RETRIEVAL_NODE_IDS.preflight]: "Preflight",
  [RETRIEVAL_NODE_IDS.execute]: "Execute retrieval",
  [RETRIEVAL_NODE_IDS.verify]: "Verify",
};

export function workflowNodeLabel(nodeId: string): string {
  return WORKFLOW_NODE_LABELS[nodeId] ?? nodeId;
}
