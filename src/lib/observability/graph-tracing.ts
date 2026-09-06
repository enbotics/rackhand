/**
 * Turning a finished Strands graph run into timeline events (Milestone 12).
 * SERVER ONLY.
 *
 * Everything here is DERIVED FROM COMMITTED RESULTS. The graph steps come from
 * the Milestone 11 workflow result; the movement status is re-read from the
 * Movement table; the gantry timings come from the controller's own operation
 * history. Nothing is inferred from graph state — a graph that reached its
 * execute node does not prove a part moved, and only the machine's own record
 * and the database can say that it did.
 *
 * THE RULE THAT MATTERS: an INVENTORY_UPDATED event is emitted only when the
 * authoritative service reports that stock actually changed. A failed gantry
 * operation produces no inventory event, and neither does an idempotent replay
 * — the second run of one scan moved nothing, so claiming a movement, a gantry
 * operation and an inventory change for it would invent physical activity that
 * never happened.
 *
 * The whole module is best-effort. Every write goes through the trace service,
 * which never throws.
 */
import { prisma } from "@/lib/warehouse/db";
import { getGantryController } from "@/lib/gantry/factory";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import type { PutawayResult } from "@/lib/warehouse/putaway-types";
import type { RetrievalResult } from "@/lib/warehouse/retrieval-types";
import { recordEvent } from "./trace-service";
import type { TraceEventType } from "./types";

const STEP_EVENT: Record<string, TraceEventType> = {
  COMPLETED: "GRAPH_STEP_COMPLETED",
  BLOCKED: "GRAPH_STEP_BLOCKED",
  FAILED: "GRAPH_STEP_FAILED",
  SKIPPED: "GRAPH_STEP_SKIPPED",
  PENDING: "GRAPH_STEP_SKIPPED",
  RUNNING: "GRAPH_STEP_COMPLETED",
};

const STEP_STATUS: Record<string, "COMPLETED" | "BLOCKED" | "FAILED" | "INFO"> = {
  COMPLETED: "COMPLETED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  SKIPPED: "INFO",
  PENDING: "INFO",
  RUNNING: "INFO",
};

function elapsed(startedAt?: string, completedAt?: string): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Reads the machine's own account of an operation, for its real duration. */
async function gantryOperation(operationId: string | undefined) {
  if (!operationId) return null;
  try {
    const operations = await getGantryController().getRecentOperations(50);
    return operations.find((operation) => operation.operationId === operationId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Emits the timeline for one completed graph run.
 *
 * Called after the run finishes, so ordering is deterministic: graph start,
 * each step, then the warehouse facts the run produced, then the graph's
 * outcome.
 */
export async function traceGraphRun(input: {
  traceId: string | null;
  graph: WarehouseGraphResult;
  result: PutawayResult | RetrievalResult;
}): Promise<void> {
  const { traceId, graph, result } = input;
  if (!traceId) return;

  await recordEvent(traceId, {
    type: "GRAPH_STARTED",
    status: "STARTED",
    name: graph.workflow,
    summary: `${graph.workflow} workflow started.`,
    metadata: { graphRunId: graph.operationId, workflow: graph.workflow },
  });

  for (const step of graph.steps) {
    await recordEvent(traceId, {
      type: STEP_EVENT[step.status] ?? "GRAPH_STEP_SKIPPED",
      status: STEP_STATUS[step.status] ?? "INFO",
      name: step.nodeId,
      summary: step.summary ?? `${step.label} ${step.status.toLowerCase()}.`,
      startedAt: step.startedAt ? new Date(step.startedAt) : null,
      completedAt: step.completedAt ? new Date(step.completedAt) : null,
      durationMs: elapsed(step.startedAt, step.completedAt),
      metadata: {
        graphRunId: graph.operationId,
        workflow: graph.workflow,
        nodeId: step.nodeId,
        ...(step.reason ? { reason: step.reason } : {}),
      },
    });
  }

  // An idempotent replay executed nothing. Emitting movement, gantry and
  // inventory events for it would describe physical activity that did not
  // happen on this run.
  const duplicate = result.ok && result.duplicate === true;

  const movementId = "movementId" in graph ? graph.movementId : undefined;
  if (movementId && !duplicate) {
    const movement = await prisma.movement.findUnique({
      where: { id: movementId },
      include: { part: true, sourceBin: true, destinationBin: true },
    });
    if (movement) {
      const route = `${movement.sourceBin?.code ?? movement.sourceLocation ?? "—"} → ${
        movement.destinationBin?.code ?? movement.destinationLocation ?? "—"
      }`;
      const failed = movement.status !== "COMPLETED";
      await recordEvent(traceId, {
        type: failed ? "MOVEMENT_FAILED" : "MOVEMENT_COMPLETED",
        status: failed ? "FAILED" : "COMPLETED",
        name: movement.type,
        // The Movement row's own status, re-read. Not the graph's opinion of it.
        summary: `Movement ${movement.status}: ${movement.type} ${movement.part.sku} ${route}.`,
        completedAt: movement.completedAt,
        metadata: {
          movementId: movement.id,
          type: movement.type,
          sku: movement.part.sku,
          status: movement.status,
        },
      });
    }
  }

  const gantryOperationId =
    "gantryOperationId" in graph ? graph.gantryOperationId : undefined;
  if (gantryOperationId && !duplicate) {
    const operation = await gantryOperation(gantryOperationId);
    if (operation) {
      const failed = operation.status !== "COMPLETED";
      await recordEvent(traceId, {
        type: failed ? "GANTRY_FAILED" : "GANTRY_COMPLETED",
        status: failed ? "FAILED" : "COMPLETED",
        name: operation.type,
        summary: failed
          ? `Gantry ${operation.type} failed: ${operation.error ?? "unknown"}.`
          : `Gantry ${operation.type} ${operation.source ?? "—"} → ${operation.destination ?? "—"} completed.`,
        startedAt: operation.startedAt ? new Date(operation.startedAt) : null,
        completedAt: operation.completedAt ? new Date(operation.completedAt) : null,
        durationMs:
          operation.startedAt && operation.completedAt
            ? operation.completedAt - operation.startedAt
            : null,
        metadata: {
          gantryOperationId: operation.operationId,
          source: operation.source,
          destination: operation.destination,
          ...(operation.error ? { error: operation.error } : {}),
        },
      });
    }
  }

  // Only after the authoritative transaction committed, and only when it
  // actually changed a quantity.
  if (result.ok && !duplicate) {
    if ("inventoryQuantityAdded" in result && result.inventoryQuantityAdded === 1) {
      await recordEvent(traceId, {
        type: "INVENTORY_UPDATED",
        status: "COMPLETED",
        name: result.part.sku,
        summary: `Inventory ${result.part.sku} in ${result.destinationBinCode}: +1.`,
        metadata: {
          sku: result.part.sku,
          bin: result.destinationBinCode,
          delta: 1,
        },
      });
    }
    if ("inventoryQuantityRemoved" in result && result.inventoryQuantityRemoved === 1) {
      await recordEvent(traceId, {
        type: "INVENTORY_UPDATED",
        status: "COMPLETED",
        name: result.part.sku,
        summary: `Inventory ${result.part.sku} in ${result.sourceBinCode}: -1, ${result.remainingQuantityInBin} remaining.`,
        metadata: {
          sku: result.part.sku,
          bin: result.sourceBinCode,
          delta: -1,
          remaining: result.remainingQuantityInBin,
        },
      });
    }
  }

  await recordEvent(traceId, {
    type:
      graph.status === "COMPLETED"
        ? "GRAPH_COMPLETED"
        : graph.status === "BLOCKED"
          ? "GRAPH_BLOCKED"
          : "GRAPH_FAILED",
    status:
      graph.status === "COMPLETED"
        ? "COMPLETED"
        : graph.status === "BLOCKED"
          ? "BLOCKED"
          : "FAILED",
    name: graph.workflow,
    summary:
      graph.status === "COMPLETED"
        ? `${graph.workflow} workflow completed.`
        : `${graph.workflow} workflow ${graph.status.toLowerCase()}: ${graph.reason}.`,
    metadata: {
      graphRunId: graph.operationId,
      workflow: graph.workflow,
      ...(graph.status === "COMPLETED" ? {} : { reason: graph.reason }),
    },
  });
}
