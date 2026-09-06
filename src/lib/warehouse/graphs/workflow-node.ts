/**
 * The deterministic node base class and shared workflow state for the
 * warehouse graphs (Milestone 11).
 *
 * SERVER ONLY. This module imports the Strands SDK and must never reach a
 * client bundle; the browser sees only the sanitized `WarehouseGraphResult`
 * from workflow-types.ts.
 *
 * WHY THE NODES ARE DETERMINISTIC CODE, NOT AGENTS. Every decision these
 * graphs make — is this scan valid, does the matcher agree, is that bin free,
 * is the gantry idle — is a programmatic fact with exactly one right answer.
 * Asking a language model any of them would add latency, cost and a chance of
 * being wrong, in exchange for nothing. The one place natural language belongs
 * is upstream, where the Warehouse Agent decides which tool the operator
 * actually wants; by the time a graph runs, that decision is made.
 *
 * HOW ROUTING WORKS. Business-critical branching never inspects prose. Each
 * node writes a typed record into the graph's shared app state, and every edge
 * carries the same structured guard (`proceedingEdge`) that reads it. A node
 * that blocks or fails leaves the run in a non-proceeding status, the guard
 * returns false, and no downstream node — including the only node that can
 * mutate the warehouse — is ever scheduled.
 */
import { TextBlock } from "@strands-agents/sdk";
import { Node, Status } from "@strands-agents/sdk/multiagent";
import type {
  EdgeHandler,
  MultiAgentInput,
  MultiAgentState,
  NodeInputOptions,
  NodeResult,
  NodeResultUpdate,
} from "@strands-agents/sdk/multiagent";
import type { MultiAgentStreamEvent } from "@strands-agents/sdk/multiagent";
import {
  workflowNodeLabel,
  type WarehouseGraphResult,
  type WorkflowKind,
  type WorkflowStepResult,
} from "./workflow-types";

/** The single key the whole workflow run lives under in `MultiAgentState.app`. */
export const WORKFLOW_STATE_KEY = "warehouseWorkflowRun";

/**
 * The key the run's input travels under in `invocationState`.
 *
 * Deliberately NOT the graph's text input. Graph input is re-serialized into
 * every downstream node's input alongside upstream content, so putting a
 * ScanResult there would copy the whole scan into six node inputs for no
 * reason. `invocationState` is threaded by reference to every node instead.
 */
export const WORKFLOW_REQUEST_KEY = "warehouseWorkflowRequest";

/**
 * Where the run record is mirrored for the graph runner.
 *
 * The authoritative copy lives in `MultiAgentState.app`, because that is what
 * edge handlers can read. `MultiAgentState` itself is internal to an
 * invocation and never returned, so the same record is also written to the
 * caller-owned `invocationState` — one object, two readers, no second source
 * of truth.
 */
export const WORKFLOW_RUN_MIRROR_KEY = "warehouseWorkflowRunMirror";

/**
 * Whether the run may continue. `PROCEEDING` is the only value that lets a
 * downstream node be scheduled.
 */
export type WorkflowRunStatus = "PROCEEDING" | "BLOCKED" | "FAILED" | "COMPLETED";

/** The typed record every node reads and writes. Must stay JSON-serializable. */
export interface WorkflowRun<TData> {
  workflow: WorkflowKind;
  operationId: string;
  status: WorkflowRunStatus;
  reason?: string;
  message?: string;
  data: TData;
  steps: WorkflowStepResult[];
}

/** What a node decides. Structured — never a sentence another node parses. */
export type NodeOutcome =
  /** Continue to the next stage. */
  | { kind: "PROCEED"; summary: string }
  /**
   * A gate said no BEFORE anything was attempted. Not a fault: an ambiguous
   * match or an empty bin is an ordinary, expected answer.
   */
  | { kind: "BLOCKED"; reason: string; message: string; summary?: string }
  /** Something was attempted and did not succeed. */
  | {
      kind: "FAILED";
      reason: string;
      message: string;
      summary?: string;
      movementId?: string;
      gantryOperationId?: string;
    };

/** What a node's `run` receives. The request is read-only; `data` is a draft. */
export interface WorkflowNodeContext<TRequest, TData> {
  request: TRequest;
  /** Mutated in place by the node; the base class writes it back to app state. */
  data: TData;
  operationId: string;
  /**
   * The caller-owned, mutable per-invocation record the SDK threads by
   * reference through every node. An execute node leaves the mutating
   * service's own result here so the graph runner can hand it back to the
   * Strands tool unchanged — the agent keeps seeing the Milestone 7/8
   * contract, not a graph-shaped rewrite of it.
   */
  invocationState: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function readWorkflowRun<TData>(state: MultiAgentState): WorkflowRun<TData> | undefined {
  return state.app.get(WORKFLOW_STATE_KEY) as unknown as WorkflowRun<TData> | undefined;
}

function writeWorkflowRun<TData>(
  state: MultiAgentState,
  invocationState: Record<string, unknown>,
  run: WorkflowRun<TData>,
): void {
  state.app.set(WORKFLOW_STATE_KEY, run);
  invocationState[WORKFLOW_RUN_MIRROR_KEY] = run;
}

/**
 * The structured guard every edge carries.
 *
 * This is the whole conditional-routing story, and it is intentionally boring:
 * one predicate over one typed field. There is no string matching, no
 * `content.includes("matched")`, and nothing a model wrote can influence it.
 */
export const proceedingEdge: EdgeHandler = (state) =>
  readWorkflowRun(state)?.status === "PROCEEDING";

/**
 * A deterministic warehouse workflow node.
 *
 * Subclasses implement `run`, which returns a structured outcome. Everything
 * else — reading shared state, recording the step, deciding the SDK-level node
 * status — happens here, so no node can forget to record itself and no node
 * can accidentally let a blocked run continue.
 */
export abstract class WorkflowNode<TRequest, TData> extends Node {
  readonly type = "warehouseWorkflowNode";

  constructor(id: string, description: string) {
    super(id, { description });
  }

  /**
   * Node-specific logic. Read-only against the warehouse unless this is the
   * single execute node of its workflow.
   */
  protected abstract run(context: WorkflowNodeContext<TRequest, TData>): Promise<NodeOutcome>;

  /**
   * Seeds the run record. Implemented only by the validate node of each graph;
   * every other node must find a run already established, and throws if it does
   * not — a node running with no workflow state is a wiring bug, not something
   * to paper over with a default.
   */
  protected seed?(request: TRequest): WorkflowRun<TData>;

  async *handle(
    _input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const request = options?.invocationState?.[WORKFLOW_REQUEST_KEY] as TRequest;
    const startedAt = nowIso();

    // The first node seeds the run; the rest must find one already there.
    let run = readWorkflowRun<TData>(state) ?? this.seed?.(request);
    if (!run) {
      throw new Error(`Node "${this.id}" ran with no workflow state seeded.`);
    }

    const invocationState = (options?.invocationState ?? {}) as Record<string, unknown>;
    const outcome = await this.run({
      request,
      data: run.data,
      operationId: run.operationId,
      invocationState,
    });

    const step: WorkflowStepResult = {
      nodeId: this.id,
      label: workflowNodeLabel(this.id),
      status:
        outcome.kind === "PROCEED"
          ? "COMPLETED"
          : outcome.kind === "BLOCKED"
            ? "BLOCKED"
            : "FAILED",
      startedAt,
      completedAt: nowIso(),
      summary: outcome.kind === "PROCEED" ? outcome.summary : (outcome.summary ?? outcome.message),
      ...(outcome.kind === "PROCEED" ? {} : { reason: outcome.reason }),
    };

    run = {
      ...run,
      status:
        outcome.kind === "PROCEED"
          ? "PROCEEDING"
          : outcome.kind === "BLOCKED"
            ? "BLOCKED"
            : "FAILED",
      ...(outcome.kind === "PROCEED"
        ? {}
        : { reason: outcome.reason, message: outcome.message }),
      steps: [...run.steps, step],
    };
    writeWorkflowRun(state, invocationState, run);

    /*
     * SDK-level status.
     *
     * A BLOCKED node reports COMPLETED: it answered its question correctly,
     * and the run stopped because of the answer, not because the node broke.
     * Reporting FAILED would make "a human must identify this part" look like
     * a machine fault in every trace and dashboard.
     *
     * A FAILED node reports FAILED, which is also what stops the chain: the
     * graph only schedules a node when every upstream node is COMPLETED, so a
     * failed execute node makes verify unreachable without any extra wiring.
     */
    return {
      status: outcome.kind === "FAILED" ? Status.FAILED : Status.COMPLETED,
      // A compact structured summary, so terminus content names the step that
      // ended the run. Never prose a downstream node parses — routing reads
      // the typed record in app state.
      content: [new TextBlock(JSON.stringify(step))],
    };
  }
}

/**
 * Creates the initial run record. Used by each graph's validate node.
 */
export function createWorkflowRun<TData>(
  workflow: WorkflowKind,
  operationId: string,
  data: TData,
): WorkflowRun<TData> {
  return { workflow, operationId, status: "PROCEEDING", data, steps: [] };
}

/**
 * Translates the Strands result into the application contract.
 *
 * Nodes that never ran are reported SKIPPED rather than omitted — "verify did
 * not happen" is information an operator needs, and a gap in the list would
 * hide it. A node the SDK marked FAILED without recording a step means the
 * node threw unexpectedly; that is surfaced rather than swallowed.
 */
export function buildGraphResult<TData>(input: {
  workflow: WorkflowKind;
  operationId: string;
  nodeOrder: readonly string[];
  run: WorkflowRun<TData> | undefined;
  /** The SDK's per-node results, straight off the MultiAgentResult. */
  nodeResults: readonly NodeResult[];
  /** Ids from the execute node, preserved on both success and failure. */
  movementId?: string;
  gantryOperationId?: string;
}): WarehouseGraphResult {
  const recorded = new Map((input.run?.steps ?? []).map((step) => [step.nodeId, step]));

  const steps: WorkflowStepResult[] = input.nodeOrder.map((nodeId) => {
    const step = recorded.get(nodeId);
    if (step) return step;
    const sdkStatus = input.nodeResults.find((result) => result.nodeId === nodeId)?.status;
    if (sdkStatus === Status.FAILED) {
      return {
        nodeId,
        label: workflowNodeLabel(nodeId),
        status: "FAILED",
        reason: "node_error",
        summary: "The workflow step did not complete.",
      };
    }
    return { nodeId, label: workflowNodeLabel(nodeId), status: "SKIPPED" };
  });

  const base = { workflow: input.workflow, operationId: input.operationId, steps };

  if (!input.run) {
    return {
      ...base,
      status: "FAILED",
      reason: "workflow_not_started",
      message: "The workflow could not be started.",
    };
  }

  if (input.run.status === "BLOCKED") {
    return {
      ...base,
      status: "BLOCKED",
      reason: input.run.reason ?? "blocked",
      message: input.run.message ?? "The workflow was stopped before anything was executed.",
    };
  }

  if (input.run.status === "FAILED" || steps.some((step) => step.status === "FAILED")) {
    return {
      ...base,
      status: "FAILED",
      reason: input.run.reason ?? "workflow_failed",
      message: input.run.message ?? "The workflow did not complete.",
      ...(input.movementId ? { movementId: input.movementId } : {}),
      ...(input.gantryOperationId ? { gantryOperationId: input.gantryOperationId } : {}),
    };
  }

  return {
    ...base,
    status: "COMPLETED",
    movementId: input.movementId ?? "",
    gantryOperationId: input.gantryOperationId ?? "",
  };
}
