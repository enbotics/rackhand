/**
 * The retrieval workflow as an official Strands `Graph` (Milestone 11).
 *
 * SERVER ONLY — imports the Strands SDK.
 *
 *     execute_retrieval  ->  RETRIEVAL GRAPH  ->  RetrievalService  ->  DB + gantry
 *
 * Same shape and the same rules as the putaway graph: a linear DAG of
 * deterministic nodes, one structured guard on every edge, no cycles, and one
 * node — and only one — allowed to change warehouse state. A retrieval that
 * fails on the machine returns to the operator; the graph never loops back to
 * try the physical move again.
 */
import { Graph } from "@strands-agents/sdk";
import {
  RETRIEVAL_NODE_IDS,
  RETRIEVAL_NODE_ORDER,
  type RetrievalGraphRun,
  type WarehouseGraphResult,
  workflowNodeLabel,
} from "./workflow-types";
import { getContextTraceId } from "@/lib/agents/request-context";
import { traceGraphRun } from "@/lib/observability/graph-tracing";
import {
  buildGraphResult,
  proceedingEdge,
  WORKFLOW_REQUEST_KEY,
  WORKFLOW_RUN_MIRROR_KEY,
  type WorkflowRun,
} from "./workflow-node";
import {
  RetrievalExecuteNode,
  RetrievalInventoryNode,
  RetrievalPartNode,
  RetrievalPreflightNode,
  RetrievalSourceNode,
  RetrievalValidateNode,
  RetrievalVerifyNode,
  RETRIEVAL_SERVICE_RESULT_KEY,
  type RetrievalGraphData,
  type RetrievalGraphRequest,
  verifyCommittedRetrieval,
} from "./retrieval-nodes";
import {
  RETRIEVAL_FAILURE_REASONS,
  type RetrievalFailureReason,
  type RetrievalResult,
} from "../retrieval-types";

export const RETRIEVAL_GRAPH_CONFIG = {
  /** Comfortably above the seven nodes. */
  maxSteps: 14,
  // Checkout includes camera/scale analysis, removal/retry and the four-minute
  // inactivity window. Match putaway's budget, below the route's five minutes.
  timeout: 290_000,
  maxConcurrency: 1,
} as const;

let cachedGraph: Graph | undefined;

export function createRetrievalGraph(): Graph {
  return new Graph({
    id: "warehouse_retrieval",
    nodes: [
      new RetrievalValidateNode(),
      new RetrievalPartNode(),
      new RetrievalInventoryNode(),
      new RetrievalSourceNode(),
      new RetrievalPreflightNode(),
      new RetrievalExecuteNode(),
      new RetrievalVerifyNode(),
    ],
    edges: [
      { source: RETRIEVAL_NODE_IDS.validate, target: RETRIEVAL_NODE_IDS.part, handler: proceedingEdge },
      { source: RETRIEVAL_NODE_IDS.part, target: RETRIEVAL_NODE_IDS.inventory, handler: proceedingEdge },
      { source: RETRIEVAL_NODE_IDS.inventory, target: RETRIEVAL_NODE_IDS.source, handler: proceedingEdge },
      { source: RETRIEVAL_NODE_IDS.source, target: RETRIEVAL_NODE_IDS.preflight, handler: proceedingEdge },
      { source: RETRIEVAL_NODE_IDS.preflight, target: RETRIEVAL_NODE_IDS.execute, handler: proceedingEdge },
      { source: RETRIEVAL_NODE_IDS.execute, target: RETRIEVAL_NODE_IDS.verify, handler: proceedingEdge },
    ],
    ...RETRIEVAL_GRAPH_CONFIG,
  });
}

export function getRetrievalGraph(): Graph {
  return (cachedGraph ??= createRetrievalGraph());
}

/**
 * Runs one retrieval workflow.
 *
 * Returns the unchanged Milestone 8 `RetrievalResult` for the agent alongside
 * the sanitized orchestration view for the operator.
 */
export async function runRetrievalGraph(
  request: RetrievalGraphRequest,
  /** Test seam, as in putaway-graph.ts. Nothing in production passes it. */
  instance: Graph = getRetrievalGraph(),
): Promise<RetrievalGraphRun> {
  const invocationState: Record<string, unknown> = { [WORKFLOW_REQUEST_KEY]: request };

  let nodeResults: Parameters<typeof buildGraphResult>[0]["nodeResults"] = [];
  try {
    nodeResults = (await instance.invoke("Run the retrieval workflow.", { invocationState })).results;
  } catch (error) {
    // The SDK checks its wall-clock budget after a deterministic node finishes.
    // Camera retries can therefore commit a real checkout before the SDK throws.
    // Never rerun that physical node: recover only its successful service result,
    // and perform the same read-only coherence check that the final node uses.
    const committed = invocationState[RETRIEVAL_SERVICE_RESULT_KEY] as RetrievalResult | undefined;
    const timedOutRun = invocationState[WORKFLOW_RUN_MIRROR_KEY] as WorkflowRun<RetrievalGraphData> | undefined;
    const isGraphTimeout = error instanceof Error
      && /^timeout=<\d+>, graph_id=<warehouse_retrieval> \| graph exceeded wall-clock budget$/.test(error.message);
    if (!isGraphTimeout || !committed?.ok || !timedOutRun
      || !["PROCEEDING", "COMPLETED"].includes(timedOutRun.status)) throw error;

    const checked = await verifyCommittedRetrieval(timedOutRun.data, committed);
    const completedAt = new Date().toISOString();
    timedOutRun.steps = timedOutRun.steps.filter((step) => step.nodeId !== RETRIEVAL_NODE_IDS.verify);
    timedOutRun.steps.push({
      nodeId: RETRIEVAL_NODE_IDS.verify,
      label: workflowNodeLabel(RETRIEVAL_NODE_IDS.verify),
      status: checked.kind === "PROCEED" ? "COMPLETED" : "FAILED",
      startedAt: completedAt,
      completedAt,
      summary: checked.summary ?? (checked.kind !== "PROCEED" ? checked.message : undefined),
      ...(checked.kind !== "PROCEED" ? { reason: checked.reason } : {}),
    });
    timedOutRun.status = checked.kind === "PROCEED" ? "COMPLETED" : "FAILED";
    if (checked.kind !== "PROCEED") {
      timedOutRun.reason = checked.reason;
      timedOutRun.message = checked.message;
      invocationState[RETRIEVAL_SERVICE_RESULT_KEY] = {
        ok: false, requestId: committed.requestId, reason: "retrieval_verification_failed",
        message: checked.message, movementId: committed.movementId,
        gantryOperationId: committed.gantryOperationId, sourceBinCode: committed.sourceBinCode,
      } satisfies RetrievalResult;
    }
  }

  const run = invocationState[WORKFLOW_RUN_MIRROR_KEY] as
    | WorkflowRun<RetrievalGraphData>
    | undefined;
  const serviceResult = invocationState[RETRIEVAL_SERVICE_RESULT_KEY] as
    | RetrievalResult
    | undefined;

  const graph = buildGraphResult<RetrievalGraphData>({
    workflow: "RETRIEVAL",
    operationId: run?.operationId ?? "wf_retrieval_unknown",
    nodeOrder: RETRIEVAL_NODE_ORDER,
    run,
    nodeResults,
    movementId: run?.data.movementId,
    gantryOperationId: run?.data.gantryOperationId,
  });

  const finalResult = serviceResult ?? synthesizeResult(graph, run);

  // Milestone 12: describe what happened, from committed results only. Purely
  // observational — it cannot fail the workflow and never throws.
  await traceGraphRun({ traceId: getContextTraceId(), graph, result: finalResult });

  return { graph, result: finalResult };
}

/**
 * Builds a `RetrievalResult` for a run that stopped before the execute node.
 *
 * A translation, not a second opinion: every reason a pre-execution node can
 * block with is already a `RetrievalFailureReason`, and the list is re-checked
 * at runtime. A graph that failed without a service result means a node threw,
 * which is an internal fault and is raised rather than dressed up as a
 * retrieval refusal.
 */
function synthesizeResult(
  graph: WarehouseGraphResult,
  run: WorkflowRun<RetrievalGraphData> | undefined,
): RetrievalResult {
  if (graph.status === "BLOCKED" && isRetrievalFailureReason(graph.reason)) {
    return {
      ok: false,
      reason: graph.reason,
      requestId: run?.data.requestId ?? "",
      message: graph.message,
      ...(run?.data.sourceBinCode ? { sourceBinCode: run.data.sourceBinCode } : {}),
    };
  }
  throw new Error(
    `Retrieval workflow ended ${graph.status} without a service result` +
      (graph.status === "COMPLETED" ? "" : ` (${graph.reason})`),
  );
}

function isRetrievalFailureReason(value: string): value is RetrievalFailureReason {
  return (RETRIEVAL_FAILURE_REASONS as readonly string[]).includes(value);
}
