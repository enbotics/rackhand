/**
 * The putaway workflow as an official Strands `Graph` (Milestone 11).
 *
 * SERVER ONLY — imports the Strands SDK.
 *
 *     execute_putaway  ->  PUTAWAY GRAPH  ->  PutawayService  ->  DB + gantry
 *
 * TOPOLOGY. A linear DAG of six deterministic nodes. Every edge carries the
 * same structured guard, `proceedingEdge`, which reads a typed field from the
 * graph's shared app state. There is no branch that depends on model prose,
 * and there is no cycle: a failed physical operation returns to the operator
 * and is never retried by the graph.
 *
 * WHY THERE IS NO SHARED "BLOCKED" NODE. The obvious drawing has every stage
 * pointing at one terminal `putaway_blocked` node. That is wrong on this SDK:
 * TypeScript Strands uses AND dependency semantics, so a node with four
 * incoming edges waits for all four sources to COMPLETE. A blocked node fed by
 * mutually exclusive branches would simply never run. Instead a stage that
 * blocks leaves the run in a non-proceeding status, its outgoing guard returns
 * false, and every downstream node stays PENDING — which the runner reports as
 * SKIPPED. The blocking stage becomes the graph's terminus on its own.
 */
import { Graph } from "@strands-agents/sdk";
import {
  PUTAWAY_NODE_IDS,
  PUTAWAY_NODE_ORDER,
  type PutawayGraphRun,
  type WarehouseGraphResult,
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
  PutawayDestinationNode,
  PutawayExecuteNode,
  PutawayIdentityNode,
  PutawayPreflightNode,
  PutawayValidateNode,
  PutawayVerifyNode,
  PUTAWAY_SERVICE_RESULT_KEY,
  type PutawayGraphData,
  type PutawayGraphRequest,
} from "./putaway-nodes";
import {
  PUTAWAY_FAILURE_REASONS,
  type PutawayFailureReason,
  type PutawayResult,
} from "../putaway-types";

/**
 * Bounds. Deliberately tight for a six-node local workflow: a graph that needs
 * hundreds of steps is a graph that has gone wrong, and the physical operation
 * underneath is a simulator that finishes in about a second.
 */
export const PUTAWAY_GRAPH_CONFIG = {
  /** Comfortably above the six nodes, nowhere near a runaway. */
  maxSteps: 12,
  /** Wall-clock ceiling for the whole workflow. */
  timeout: 180_000,
  /** The chain is strictly sequential; state it rather than relying on topology. */
  maxConcurrency: 1,
} as const;

/**
 * Built once and reused. The nodes hold no per-run state — everything lives in
 * the per-invocation `MultiAgentState.app` and `invocationState` — so one
 * instance is safe under concurrent invocations.
 */
let cachedGraph: Graph | undefined;

export function createPutawayGraph(): Graph {
  return new Graph({
    id: "warehouse_putaway",
    nodes: [
      new PutawayValidateNode(),
      new PutawayIdentityNode(),
      new PutawayDestinationNode(),
      new PutawayPreflightNode(),
      new PutawayExecuteNode(),
      new PutawayVerifyNode(),
    ],
    edges: [
      { source: PUTAWAY_NODE_IDS.validate, target: PUTAWAY_NODE_IDS.identity, handler: proceedingEdge },
      { source: PUTAWAY_NODE_IDS.identity, target: PUTAWAY_NODE_IDS.destination, handler: proceedingEdge },
      { source: PUTAWAY_NODE_IDS.destination, target: PUTAWAY_NODE_IDS.preflight, handler: proceedingEdge },
      { source: PUTAWAY_NODE_IDS.preflight, target: PUTAWAY_NODE_IDS.execute, handler: proceedingEdge },
      { source: PUTAWAY_NODE_IDS.execute, target: PUTAWAY_NODE_IDS.verify, handler: proceedingEdge },
    ],
    ...PUTAWAY_GRAPH_CONFIG,
  });
}

export function getPutawayGraph(): Graph {
  return (cachedGraph ??= createPutawayGraph());
}

/**
 * Runs one putaway workflow.
 *
 * Returns BOTH views: `result` is the unchanged Milestone 7 `PutawayResult`
 * the Strands tool hands back to the agent, and `graph` is the sanitized
 * orchestration view for the operator. Wrapping the service in a graph
 * deliberately changed no agent-visible contract.
 */
export async function runPutawayGraph(
  request: PutawayGraphRequest,
  /**
   * Test seam: run a freshly built graph instead of the shared one, so a test
   * can attach an SDK hook (e.g. to mutate the warehouse between preflight and
   * execute) without affecting production runs. Nothing in production passes it.
   */
  instance: Graph = getPutawayGraph(),
): Promise<PutawayGraphRun> {
  // Threaded by reference to every node. The scan travels here rather than in
  // the graph's text input, which would be re-serialized into each downstream
  // node's input alongside upstream content.
  const invocationState: Record<string, unknown> = { [WORKFLOW_REQUEST_KEY]: request };

  const outcome = await instance.invoke("Run the putaway workflow.", { invocationState });

  const run = invocationState[WORKFLOW_RUN_MIRROR_KEY] as
    | WorkflowRun<PutawayGraphData>
    | undefined;
  const serviceResult = invocationState[PUTAWAY_SERVICE_RESULT_KEY] as PutawayResult | undefined;

  const graph = buildGraphResult<PutawayGraphData>({
    workflow: "PUTAWAY",
    operationId: run?.operationId ?? "wf_putaway_unknown",
    nodeOrder: PUTAWAY_NODE_ORDER,
    run,
    nodeResults: outcome.results,
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
 * Builds a `PutawayResult` for a run that stopped before the execute node.
 *
 * Nothing is invented: every reason a pre-execution node can block with is
 * already a `PutawayFailureReason`, so this is a translation, not a second
 * opinion, and the list is re-checked at runtime rather than asserted by a
 * cast. It exists so the tool's return shape is identical whether the graph
 * stopped early or the service refused.
 *
 * A graph that failed WITHOUT a service result means a node threw — an
 * internal fault, not a warehouse answer. That throws rather than being dressed
 * up as a putaway refusal, and the tool's existing error handling reports it.
 */
function synthesizeResult(
  graph: WarehouseGraphResult,
  run: WorkflowRun<PutawayGraphData> | undefined,
): PutawayResult {
  if (graph.status === "BLOCKED" && isPutawayFailureReason(graph.reason)) {
    return {
      ok: false,
      reason: graph.reason,
      scanId: run?.data.scanId ?? "",
      message: graph.message,
    };
  }
  throw new Error(
    `Putaway workflow ended ${graph.status} without a service result` +
      (graph.status === "COMPLETED" ? "" : ` (${graph.reason})`),
  );
}

function isPutawayFailureReason(value: string): value is PutawayFailureReason {
  return (PUTAWAY_FAILURE_REASONS as readonly string[]).includes(value);
}
