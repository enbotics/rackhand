/**
 * Request-scoped context for one agent turn: the validated ScanResult, and a
 * stable id identifying the request itself.
 *
 * WHY THE SCAN TRAVELS HERE. The obvious design — let the model pass a
 * ScanResult as a tool argument — quietly destroys the guarantee Milestones
 * 1-3 were built for. Dimensions come from QR-mat homography, not from a
 * language model; if the model can author the numbers the deterministic
 * matcher scores, the matcher is scoring a hallucination. So the authoritative
 * scan travels out-of-band, server-side, and never through the message
 * history. It also keeps the prompt-injection boundary intact: scan text
 * (detectedName, description) is never concatenated into the system prompt.
 *
 * WHY THE REQUEST ID TRAVELS HERE (Milestone 8). One operator message must
 * cause at most one physical retrieval. A model that calls execute_retrieval
 * twice inside a single turn — a retry after a confusing answer, say — would
 * otherwise fetch two parts. Deriving the idempotency key from the HTTP
 * request rather than from the model's own choice makes that structurally
 * impossible, without the model having to remember anything.
 *
 * AsyncLocalStorage rather than module-level variables, so concurrent requests
 * cannot read each other's context.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";

interface RequestContext {
  browserScenario: "CONTROL_MODULE" | null;
  /** Already validated by the API layer. Tools may trust its shape, not its meaning. */
  scanResult: ScanResult | null;
  /** Raw camera evidence paired with scanResult; never authored by the model. */
  scanImageDataUrl: string | null;
  /** Stable for the lifetime of one HTTP request; the default idempotency key. */
  requestId: string | null;
  /** Browser/operator workflow that owns any camera request created this turn. */
  workflowSessionId: string | null;
  /**
   * A confirmed human identity decision the OPERATOR attached to this request
   * (Milestone 9). It travels out-of-band for the same reason the scan does:
   * the model must not be able to name a resolution, because doing so would
   * let it authorise an identity it was explicitly forbidden from choosing.
   */
  catalogResolutionId: string | null;
  /**
   * The observability trace this request belongs to (Milestone 12).
   *
   * It rides here for the same reason the request id does: the graph runners
   * and the tools that call them are several layers below the API and would
   * otherwise need a trace parameter threaded through every signature purely
   * for logging. A HITL resume restores the ORIGINAL trace id, so an
   * interrupted request and its approval are one timeline, not two.
   *
   * Correlation only. Nothing reads a trace to decide warehouse state.
   */
  traceId: string | null;
  /**
   * Workflow results recorded by the Strands graphs this turn (Milestone 11).
   *
   * Written by the write tools, read by the agent layer after the turn ends,
   * so a graph run can reach the operator's screen without the model having to
   * describe it — and without any raw SDK object crossing an API boundary.
   * Bounded by the number of write tools the model can call in one turn.
   */
  workflows: WarehouseGraphResult[];
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** `req_<timestamp>_<random>` — same shape as scan and gantry operation ids. */
export function createRequestId(): string {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `req_${Date.now()}_${suffix}`;
}

/** Runs `fn` with this request's scan and id visible to any tool it invokes. */
export function runWithRequestContext<T>(
  context: {
    scanResult?: ScanResult | null;
    scanImageDataUrl?: string | null;
    requestId?: string | null;
    catalogResolutionId?: string | null;
    traceId?: string | null;
    workflowSessionId?: string | null;
    browserScenario?: "CONTROL_MODULE" | null;
  },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      browserScenario: context.browserScenario ?? null,
      scanResult: context.scanResult ?? null,
      scanImageDataUrl: context.scanImageDataUrl ?? null,
      requestId: context.requestId ?? null,
      catalogResolutionId: context.catalogResolutionId ?? null,
      traceId: context.traceId ?? null,
      workflowSessionId: context.workflowSessionId ?? null,
      workflows: [],
    },
    fn,
  );
}

/** The validated ScanResult attached to this request, if any. */
export function getContextScanResult(): ScanResult | null {
  return requestContextStorage.getStore()?.scanResult ?? null;
}

/** The camera frame that produced the attached scan, if any. */
export function getContextScanImageDataUrl(): string | null {
  return requestContextStorage.getStore()?.scanImageDataUrl ?? null;
}

/** This request's stable id, if the API layer established one. */
export function getContextRequestId(): string | null {
  return requestContextStorage.getStore()?.requestId ?? null;
}

/** The browser/operator workflow that owns physical UI created this turn. */
export function getContextWorkflowSessionId(): string | null {
  return requestContextStorage.getStore()?.workflowSessionId ?? null;
}
export function getContextBrowserScenario(): "CONTROL_MODULE" | null {
  return requestContextStorage.getStore()?.browserScenario ?? null;
}

/** The operator's confirmed identity decision attached to this request, if any. */
export function getContextCatalogResolutionId(): string | null {
  return requestContextStorage.getStore()?.catalogResolutionId ?? null;
}

/** The observability trace this request belongs to, if any. */
export function getContextTraceId(): string | null {
  return requestContextStorage.getStore()?.traceId ?? null;
}

/** Records one Strands graph workflow run against this request. */
export function recordContextWorkflow(result: WarehouseGraphResult): void {
  requestContextStorage.getStore()?.workflows.push(result);
}

/** Workflow runs recorded during this request, oldest first. */
export function getContextWorkflows(): WarehouseGraphResult[] {
  return requestContextStorage.getStore()?.workflows ?? [];
}
