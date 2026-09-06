/**
 * Persistence for agent traces (Milestone 12). SERVER ONLY.
 *
 * THE CENTRAL RULE OF THIS MODULE: it must never break anything.
 *
 * Observability is a description of the warehouse, not part of it. A trace
 * that fails to save must not fail a read, must not fail a write, and above
 * all must not cause a physical operation to be retried — the part has already
 * moved, and moving it twice because a log row would not insert is the worst
 * outcome in the system. So every function here swallows its own errors and
 * reports them on the server log alone.
 *
 * The corollary holds too: nothing may read a trace to decide warehouse state.
 * Inventory, Bin, Movement and Part stay authoritative, and this module has no
 * write access to any of them.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/warehouse/db";
import {
  isTerminalTraceStatus,
  traceCategory,
  type TraceEventStatus,
  type TraceEventType,
  type TraceEventView,
  type TraceMetrics,
  type TraceStatus,
  type TraceSummaryView,
  type TraceView,
} from "./types";
import { sanitizeMetadata, sanitizeRequestSummary, sanitizeSummary } from "./sanitize";

/** `trace_<timestamp>_<random>` — server-generated, never accepted from a browser. */
export function createTraceId(): string {
  return `trace_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * The trace id for one catalog-resolution decision (Milestone 9 + 12).
 *
 * Derived from the resolution id rather than stored, so the CONFIRM or REJECT
 * that arrives minutes later on a separate HTTP request finds the same
 * timeline without a correlation column. Safe to derive because a resolution
 * id is itself a randomUUID — this exposes nothing that was not already known
 * to whoever holds it.
 *
 * A resolution is its own operator request and therefore its own trace. It is
 * deliberately NOT folded into the agent turn that scanned the part: those are
 * separate requests, and pretending otherwise would invent a timeline.
 */
export function catalogResolutionTraceId(resolutionId: string): string {
  return `trace_res_${resolutionId}`;
}

/**
 * Per-trace display order.
 *
 * In-process because one trace's events are emitted from one request, in
 * order. The map is re-hydrated from the database on a miss, which is what
 * makes a HITL resume continue the same numbering after the original request
 * has long since finished.
 */
const sequences = new Map<string, number>();

async function nextSequence(traceId: string): Promise<number> {
  const cached = sequences.get(traceId);
  if (cached !== undefined) {
    const next = cached + 1;
    sequences.set(traceId, next);
    return next;
  }
  const highest = await prisma.traceEvent.findFirst({
    where: { traceId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const next = (highest?.sequence ?? 0) + 1;
  sequences.set(traceId, next);
  return next;
}

/** Keeps the in-process map from growing without bound in a long-lived server. */
const MAX_TRACKED_SEQUENCES = 200;
function forgetOldSequences(): void {
  while (sequences.size > MAX_TRACKED_SEQUENCES) {
    const oldest = sequences.keys().next().value;
    if (oldest === undefined) break;
    sequences.delete(oldest);
  }
}

function logTrace(fields: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[trace] ${fields}`);
}

/** Never throws. An observability failure is logged and then forgotten. */
function swallow(operation: string, err: unknown): void {
  console.error(
    `[trace] ${operation} failed — observability only, the warehouse operation is unaffected:`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * Opens a trace for one agent request.
 *
 * `requestSummary` is the operator's own message, truncated to
 * MAX_REQUEST_SUMMARY_LENGTH (500 characters, see sanitize.ts). No system
 * prompt, no notices the server appended, and no model output.
 */
export async function startTrace(input: {
  traceId?: string;
  requestSummary: unknown;
}): Promise<string> {
  const traceId = input.traceId ?? createTraceId();
  try {
    await prisma.agentTrace.create({
      data: {
        id: traceId,
        status: "RUNNING",
        requestSummary: sanitizeRequestSummary(input.requestSummary),
      },
    });
    sequences.set(traceId, 0);
    forgetOldSequences();
  } catch (err) {
    swallow(`startTrace ${traceId}`, err);
  }
  return traceId;
}

export interface RecordEventInput {
  type: TraceEventType;
  status: TraceEventStatus;
  name?: string | null;
  summary: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  /** Sanitized here, unconditionally — callers cannot opt out. */
  metadata?: unknown;
}

/** Appends one timeline row. Never throws. */
export async function recordEvent(
  traceId: string | null | undefined,
  input: RecordEventInput,
): Promise<void> {
  if (!traceId) return;
  try {
    const metadata = sanitizeMetadata(input.metadata);
    const sequence = await nextSequence(traceId);
    await prisma.traceEvent.create({
      data: {
        traceId,
        sequence,
        type: input.type,
        status: input.status,
        name: input.name ?? null,
        summary: sanitizeSummary(input.summary),
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        durationMs: input.durationMs ?? null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
      },
    });
    logTrace(
      `trace=${traceId} seq=${sequence} type=${input.type}` +
        (input.name ? ` name=${input.name}` : "") +
        (input.durationMs != null ? ` duration_ms=${input.durationMs}` : ""),
    );
  } catch (err) {
    // A dropped event loses information, never correctness.
    swallow(`recordEvent ${input.type}`, err);
  }
}

/** Moves a trace to a non-terminal status (e.g. WAITING_FOR_APPROVAL). */
export async function setTraceStatus(
  traceId: string | null | undefined,
  status: TraceStatus,
): Promise<void> {
  if (!traceId) return;
  try {
    await prisma.agentTrace.update({ where: { id: traceId }, data: { status } });
  } catch (err) {
    swallow(`setTraceStatus ${traceId}`, err);
  }
}

/** Closes a trace. Never throws. */
export async function completeTrace(
  traceId: string | null | undefined,
  input: {
    status: TraceStatus;
    error?: { code: string; message: string } | null;
    metrics?: Partial<TraceMetrics> | null;
  },
): Promise<void> {
  if (!traceId) return;
  try {
    const trace = await prisma.agentTrace.findUnique({ where: { id: traceId } });
    if (!trace) return;
    const completedAt = new Date();
    await prisma.agentTrace.update({
      where: { id: traceId },
      data: {
        status: input.status,
        completedAt,
        durationMs: completedAt.getTime() - trace.startedAt.getTime(),
        errorCode: input.error?.code ?? null,
        errorMessage: input.error?.message ?? null,
        ...(input.metrics
          ? {
              modelCalls: input.metrics.modelCalls ?? null,
              inputTokens: input.metrics.inputTokens ?? null,
              outputTokens: input.metrics.outputTokens ?? null,
              totalTokens: input.metrics.totalTokens ?? null,
              modelLatencyMs: input.metrics.modelLatencyMs ?? null,
            }
          : {}),
      },
    });
    if (isTerminalTraceStatus(input.status)) sequences.delete(traceId);
    logTrace(`trace=${traceId} status=${input.status}`);
  } catch (err) {
    swallow(`completeTrace ${traceId}`, err);
  }
}

/* ------------------------------------------------------------- reading */

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function getTrace(traceId: string): Promise<TraceView | null> {
  const trace = await prisma.agentTrace.findUnique({
    where: { id: traceId },
    include: { events: { orderBy: { sequence: "asc" } } },
  });
  if (!trace) return null;

  const events: TraceEventView[] = trace.events.map((event) => ({
    sequence: event.sequence,
    type: event.type,
    category: traceCategory(event.type),
    status: event.status as TraceEventStatus,
    name: event.name,
    summary: event.summary,
    startedAt: event.startedAt?.toISOString() ?? null,
    completedAt: event.completedAt?.toISOString() ?? null,
    durationMs: event.durationMs,
    metadata: parseMetadata(event.metadataJson),
  }));

  return {
    traceId: trace.id,
    status: trace.status as TraceStatus,
    requestSummary: trace.requestSummary,
    startedAt: trace.startedAt.toISOString(),
    completedAt: trace.completedAt?.toISOString() ?? null,
    durationMs: trace.durationMs,
    error: trace.errorCode ? { code: trace.errorCode, message: trace.errorMessage ?? "" } : null,
    metrics: {
      modelCalls: trace.modelCalls,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      totalTokens: trace.totalTokens,
      modelLatencyMs: trace.modelLatencyMs,
    },
    events,
  };
}

export const DEFAULT_TRACE_LIST_LIMIT = 15;
const MAX_TRACE_LIST_LIMIT = 50;

export async function listTraces(options: { limit?: number; status?: string } = {}): Promise<
  TraceSummaryView[]
> {
  const limit =
    options.limit && Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_TRACE_LIST_LIMIT)
      : DEFAULT_TRACE_LIST_LIMIT;

  const traces = await prisma.agentTrace.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { _count: { select: { events: true } } },
  });

  return traces.map((trace) => ({
    traceId: trace.id,
    status: trace.status as TraceStatus,
    requestSummary: trace.requestSummary,
    startedAt: trace.startedAt.toISOString(),
    completedAt: trace.completedAt?.toISOString() ?? null,
    durationMs: trace.durationMs,
    eventCount: trace._count.events,
  }));
}

/**
 * Deterministic retention: keeps the newest `keep` traces and deletes the
 * rest, with their events following by cascade.
 *
 * Not scheduled. There is no background worker, no cron and no timer — this is
 * called explicitly (tests, or a developer) so retention can never surprise a
 * demo by deleting the run someone was about to show.
 */
export const DEFAULT_TRACE_RETENTION = 500;

export async function pruneTraces(keep: number = DEFAULT_TRACE_RETENTION): Promise<number> {
  try {
    const survivors = await prisma.agentTrace.findMany({
      orderBy: { startedAt: "desc" },
      take: keep,
      select: { id: true },
    });
    const { count } = await prisma.agentTrace.deleteMany({
      where: { id: { notIn: survivors.map((trace) => trace.id) } },
    });
    return count;
  } catch (err) {
    swallow("pruneTraces", err);
    return 0;
  }
}

/** Test helper: forget cached sequence counters without touching stored rows. */
export function clearTraceSequenceCache(): void {
  sequences.clear();
}
