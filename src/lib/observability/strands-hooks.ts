/**
 * Tool tracing through the official Strands hook system (Milestone 12).
 * SERVER ONLY.
 *
 * Tool calls are discovered from `BeforeToolCallEvent` and `AfterToolCallEvent`
 * — the SDK's own lifecycle events — not by parsing console output and not by
 * patching agent internals. The correlation id is the SDK's `toolUseId`, used
 * as given; this module invents no id of its own.
 *
 * THESE HOOKS ARE PASSIVE. `BeforeToolCallEvent` can cancel a call, swap the
 * selected tool or rewrite the input; `AfterToolCallEvent` can replace the
 * result or set `retry`. None of that is touched here, and a test asserts it.
 * The reason is concrete: these tools drive a physical machine, and a retry
 * requested by a logging layer would move a real part a second time. Safety
 * decisions belong to Milestones 7-11; this layer only watches.
 */
import type { Agent } from "@strands-agents/sdk";
import { AfterToolCallEvent, BeforeToolCallEvent } from "@strands-agents/sdk";
import { recordEvent } from "./trace-service";

/** The key the traceId travels under in the Strands `invocationState`. */
export const TRACE_ID_STATE_KEY = "warehouseTraceId";

/**
 * The key under which these hooks note which tools reported failure
 * (Milestone 13).
 *
 * WHY THIS IS STILL PASSIVE. The hook appends tool NAMES to a private array in
 * the SDK's own per-invocation bag. It does not touch the tool name it
 * reports on, the input, `cancel`, `selectedTool`, the result or `retry`, so
 * no tool behaves differently because observability is attached.
 *
 * It records names rather than a boolean because the agent layer has to tell
 * the two cases apart: a read-only tool that failed and was immediately
 * retried is noise, while a WRITE tool that threw means a physical action was
 * attempted and did not happen. Only the agent layer knows which tools write,
 * so the judgement lives there and this hook only reports what it saw.
 */
export const FAILED_TOOLS_STATE_KEY = "warehouseFailedTools";

/** Names of tools that failed during the invocation this state belongs to. */
export function failedToolNames(
  invocationState: Record<string, unknown> | undefined,
): string[] {
  const value = invocationState?.[FAILED_TOOLS_STATE_KEY];
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

/**
 * Start times keyed by the SDK's `toolUseId`, so a duration is a real elapsed
 * measurement rather than a difference of wall clocks. Bounded: a tool whose
 * "after" event never arrives must not leak.
 */
const started = new Map<string, { at: number; startedAt: Date }>();
const MAX_TRACKED_TOOLS = 100;

function traceIdOf(invocationState: Record<string, unknown> | undefined): string | null {
  const value = invocationState?.[TRACE_ID_STATE_KEY];
  return typeof value === "string" && value !== "" ? value : null;
}

/* --------------------------------------------------- input summaries */

/**
 * What an operator needs to see about a tool's input.
 *
 * An explicit allowlist per tool, not a dump of the arguments: a model can put
 * anything in a tool input, and the point of a trace is the few fields that
 * describe the warehouse action. Everything here also passes through
 * sanitizeMetadata inside the trace service.
 */
function describeToolInput(name: string, input: unknown): Record<string, unknown> {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  switch (name) {
    case "execute_putaway":
      return { destinationBinCode: args.destinationBinCode ?? "(chosen at execution)" };
    case "execute_retrieval":
      return {
        sku: args.sku,
        partId: args.partId,
        sourceBinCode: args.sourceBinCode ?? "(chosen at execution)",
        quantity: args.quantity,
      };
    case "execute_inventory_audit":
      return { binCode: args.binCode ?? "all auditable shelf bins" };
    case "inventory_auditor":
      // Natural-language delegated input can contain arbitrary prompt text;
      // traces record only that the specialist was consulted.
      return {};
    case "search_inventory":
    case "search_catalog":
      return { query: args.query ?? args.sku ?? args.text };
    case "get_part":
      return { sku: args.sku, partId: args.partId };
    case "get_bin_status":
      return { binCode: args.binCode ?? args.code };
    default:
      // match_catalog, list_available_bins and get_gantry_status take nothing
      // worth recording — the scan travels out-of-band and is never an argument.
      return {};
  }
}

/* -------------------------------------------------- result summaries */

/** Pulls the tool's returned object out of the SDK's result block. */
function resultPayload(content: readonly unknown[]): Record<string, unknown> | null {
  for (const block of content) {
    const candidate = block as { type?: unknown; json?: unknown };
    if (candidate?.type === "jsonBlock" && typeof candidate.json === "object" && candidate.json) {
      return candidate.json as Record<string, unknown>;
    }
  }
  return null;
}

/** Reads the search_inventory tool's own result shape. */
function inventoryLine(payload: Record<string, unknown>): string | null {
  if (payload.found !== true) {
    return payload.reason === "part_not_found"
      ? `No catalog part matches that query.`
      : `That query matched more than one part.`;
  }
  const part = payload.part as { sku?: unknown } | undefined;
  const locations = payload.locations;
  const where = Array.isArray(locations)
    ? locations
        .slice(0, 3)
        .map((entry) => {
          const location = entry as { binCode?: unknown; quantity?: unknown };
          return `${location.binCode} (${location.quantity})`;
        })
        .join(", ")
    : null;
  return `${part?.sku ?? "part"} — ${payload.totalQuantity ?? 0} in stock${where ? `, ${where}` : ""}`;
}

/**
 * One readable sentence about what a tool did, built from its structured
 * result. Never the model's words about it.
 */
function describeToolResult(
  name: string,
  payload: Record<string, unknown> | null,
): { summary: string; metadata: Record<string, unknown> } {
  if (!payload) return { summary: `${name} completed.`, metadata: {} };

  switch (name) {
    case "execute_putaway": {
      if (payload.ok === true) {
        const part = payload.part as { sku?: unknown } | undefined;
        return {
          summary: `${part?.sku ?? "part"} put away → ${payload.destinationBinCode}.`,
          metadata: {
            sku: part?.sku,
            destination: payload.destinationBinCode,
            movementId: payload.movementId,
            gantryOperationId: payload.gantryOperationId,
            inventoryAdded: payload.inventoryQuantityAdded,
            inventoryRemoved: payload.inventoryQuantityRemoved,
            quantityBefore: payload.inventoryQuantityBefore,
            quantityAfter: payload.inventoryQuantityAfter,
            observedQuantity: payload.observedQuantity,
            reconciledCheckout: payload.reconciledCheckout,
            duplicate: payload.duplicate,
          },
        };
      }
      return {
        summary: `Putaway refused: ${payload.reason}.`,
        metadata: { reason: payload.reason, movementId: payload.movementId },
      };
    }
    case "execute_retrieval": {
      if (payload.ok === true) {
        const part = payload.part as { sku?: unknown } | undefined;
        return {
          summary: `${part?.sku ?? "part"} retrieved — ${payload.sourceBinCode} → ${payload.destination}.`,
          metadata: {
            sku: part?.sku,
            source: payload.sourceBinCode,
            destination: payload.destination,
            movementId: payload.movementId,
            gantryOperationId: payload.gantryOperationId,
            checkedOutQuantity: payload.checkedOutQuantity,
            inventoryRemoved: payload.inventoryQuantityRemoved,
          },
        };
      }
      return {
        summary: `Retrieval refused: ${payload.reason}.`,
        metadata: { reason: payload.reason, movementId: payload.movementId },
      };
    }
    case "execute_inventory_audit": {
      const completed = Number(payload.binsCompleted ?? 0);
      const reconciled = Number(payload.reconciledBins ?? 0);
      const review = Number(payload.reviewRequiredBins ?? 0);
      return {
        summary:
          payload.status === "FAILED"
            ? "Inventory audit failed."
            : `Inventory audit completed ${completed} bin(s): ${reconciled} reconciled, ${review} for review.`,
        metadata: {
          auditRunId: payload.auditRunId,
          status: payload.status,
          binsCompleted: payload.binsCompleted,
          reconciledBins: payload.reconciledBins,
          reviewRequiredBins: payload.reviewRequiredBins,
          failedBins: payload.failedBins,
        },
      };
    }
    case "inventory_auditor":
      return { summary: "Inventory Auditor agent completed.", metadata: {} };
    case "search_inventory": {
      const part = payload.part as { sku?: unknown } | undefined;
      return {
        summary: inventoryLine(payload) ?? "No stock matched that query.",
        metadata: { sku: part?.sku, totalQuantity: payload.totalQuantity },
      };
    }
    case "match_catalog": {
      const matched = payload.matchedPart as { sku?: unknown } | undefined;
      return {
        summary:
          payload.status === "MATCHED"
            ? `Matched ${matched?.sku} (${Math.round(Number(payload.confidence ?? 0) * 100)}%).`
            : `Catalog match is ${payload.status}.`,
        metadata: { status: payload.status, sku: matched?.sku },
      };
    }
    case "get_gantry_status":
      return {
        summary: `Gantry ${payload.state} at ${payload.currentLocation ?? "HOME"}.`,
        metadata: { state: payload.state, mode: payload.mode },
      };
    default: {
      const count = Array.isArray(payload.results)
        ? payload.results.length
        : Array.isArray(payload.bins)
          ? payload.bins.length
          : null;
      return {
        summary: count === null ? `${name} completed.` : `${name} returned ${count} result(s).`,
        metadata: {},
      };
    }
  }
}

/* ---------------------------------------------------------- wiring */

/**
 * Registers the two passive tool hooks on an agent.
 *
 * Called once per agent construction. The traceId is read from the
 * per-invocation state the caller supplies, so one agent instance can be used
 * for a run without the trace identity being baked into it.
 */
export function attachTraceHooks(agent: Agent): void {
  agent.addHook(BeforeToolCallEvent, (event) => {
    const traceId = traceIdOf(event.invocationState as Record<string, unknown>);
    if (!traceId) return;

    const startedAt = new Date();
    if (started.size >= MAX_TRACKED_TOOLS) started.clear();
    started.set(event.toolUse.toolUseId, { at: performance.now(), startedAt });

    void recordEvent(traceId, {
      type: "TOOL_STARTED",
      status: "STARTED",
      name: event.toolUse.name,
      summary: `${event.toolUse.name} requested.`,
      startedAt,
      metadata: {
        toolUseId: event.toolUse.toolUseId,
        ...describeToolInput(event.toolUse.name, event.toolUse.input),
      },
    });
    // Nothing is assigned to event.cancel or event.selectedTool. This hook
    // observes; it never decides.
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    const state = event.invocationState as Record<string, unknown> | undefined;
    const failed = event.result.status === "error" || event.error !== undefined;

    // Recorded before the trace guard: which tools failed is a fact about the
    // turn, not about whether anyone is tracing it.
    if (failed && state) {
      const seen = Array.isArray(state[FAILED_TOOLS_STATE_KEY])
        ? (state[FAILED_TOOLS_STATE_KEY] as unknown[])
        : [];
      state[FAILED_TOOLS_STATE_KEY] = [...seen, event.toolUse.name];
    }

    const traceId = traceIdOf(state);
    if (!traceId) return;

    const begun = started.get(event.toolUse.toolUseId);
    started.delete(event.toolUse.toolUseId);
    const completedAt = new Date();
    const durationMs = begun ? Math.round(performance.now() - begun.at) : null;

    if (failed) {
      void recordEvent(traceId, {
        type: "TOOL_FAILED",
        status: "FAILED",
        name: event.toolUse.name,
        // The tool's own error message only — never a stack trace, and never
        // whatever the provider put in `cause`.
        summary: `${event.toolUse.name} failed.`,
        startedAt: begun?.startedAt ?? null,
        completedAt,
        durationMs,
        metadata: { toolUseId: event.toolUse.toolUseId },
      });
      return;
    }

    const payload = resultPayload(event.result.content);
    const described = describeToolResult(event.toolUse.name, payload);
    void recordEvent(traceId, {
      type: "TOOL_COMPLETED",
      status: "COMPLETED",
      name: event.toolUse.name,
      summary: described.summary,
      startedAt: begun?.startedAt ?? null,
      completedAt,
      durationMs,
      metadata: { toolUseId: event.toolUse.toolUseId, ...described.metadata },
    });
    // event.retry is deliberately left untouched: an observability layer must
    // never cause a physical operation to run again.
  });
}

/** Test helper: forget in-flight tool timings. */
export function clearToolTimings(): void {
  started.clear();
}
