"use client";

import { useState } from "react";
import type { TraceEventView, TraceSummaryView, TraceView } from "@/lib/observability/types";
import {
  TRACE_EVENT_STATUS_PRESENTATION,
  TRACE_STATUS_PRESENTATION,
  formatClockSeconds,
  formatDuration,
} from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, ErrorNote, Panel, StatusChip, toneText } from "./ui";

const ACTIVITY_STAGES = {
  OBSERVE: { label: "OBSERVE", tone: "accent" as const, symbol: "◇" },
  DECIDE: { label: "DECIDE", tone: "warn" as const, symbol: "◆" },
  ACT: { label: "ACT", tone: "neutral" as const, symbol: "▸" },
  RESULT: { label: "RESULT", tone: "ok" as const, symbol: "✓" },
};

type ActivityStage = keyof typeof ACTIVITY_STAGES;

function activityStage(event: TraceEventView): ActivityStage {
  if (
    event.type.startsWith("APPROVAL_") ||
    event.type.startsWith("CATALOG_RESOLUTION_")
  ) {
    return "DECIDE";
  }
  if (
    event.type === "AGENT_COMPLETED" ||
    event.type === "AGENT_FAILED" ||
    event.type === "GRAPH_COMPLETED" ||
    event.type === "GRAPH_BLOCKED" ||
    event.type === "GRAPH_FAILED"
  ) {
    return "RESULT";
  }
  if (event.category === "GANTRY" || event.category === "WAREHOUSE") return "ACT";
  if (event.category === "GRAPH") return event.type === "GRAPH_STARTED" ? "DECIDE" : "ACT";
  if (event.category === "TOOL") {
    return event.name?.startsWith("execute_") || event.name?.startsWith("run_")
      ? "ACT"
      : "OBSERVE";
  }
  return event.status === "FAILED" ? "RESULT" : "OBSERVE";
}

/**
 * The agent activity timeline (Milestone 12).
 *
 * WHAT HAPPENED, NEVER WHY THE MODEL THOUGHT IT. Every line here was built
 * server-side from a warehouse fact — a tool that ran, a person who decided, a
 * graph step, a movement, a gantry operation, a quantity that changed. No
 * chain-of-thought, no scratchpad, no reasoning tokens and no system prompt is
 * stored, so none can be rendered.
 *
 * It is a timeline, not a log viewer: one readable line per event, with the
 * small sanitized detail tucked behind a click. Nothing on this panel can
 * cause a warehouse action — there is no re-run, no replay, and the API behind
 * it only answers GET.
 */
function TraceRow({ event }: { event: TraceEventView }) {
  const [open, setOpen] = useState(false);
  const stage = ACTIVITY_STAGES[activityStage(event)];
  const status = TRACE_EVENT_STATUS_PRESENTATION[event.status];
  const duration = formatDuration(event.durationMs);
  const clock = event.completedAt ?? event.startedAt;
  const hasDetail = event.metadata !== null && Object.keys(event.metadata).length > 0;

  return (
    <li className="border-b border-line-soft last:border-b-0">
      <div className="flex items-baseline gap-3 py-1.5">
        <span className="w-[68px] shrink-0 font-mono text-[10px] text-ink-faint">
          {clock ? formatClockSeconds(clock) : ""}
        </span>

        <span
          className={`w-[86px] shrink-0 font-mono text-[10px] tracking-[0.1em] ${toneText(stage.tone)}`}
        >
          <span aria-hidden="true" className="mr-1">
            {stage.symbol}
          </span>
          {stage.label}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 text-xs text-ink">
              {event.name && (
                <span className="font-mono text-[11px] text-ink-muted">{event.name} </span>
              )}
              {event.summary}
            </p>
            <span className="flex shrink-0 items-baseline gap-2">
              {duration && (
                <span className="font-mono text-[10px] text-ink-faint">{duration}</span>
              )}
              <span
                aria-label={status.label}
                className={`font-mono text-[11px] ${toneText(status.tone)}`}
              >
                {status.symbol}
              </span>
            </span>
          </div>

          {hasDetail && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="mt-0.5 font-mono text-[10px] text-ink-faint transition-colors hover:text-accent"
            >
              {open ? "hide detail" : "detail"}
            </button>
          )}

          {open && hasDetail && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-line-soft bg-bg-elevated px-2.5 py-2">
              {Object.entries(event.metadata ?? {}).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-[10px] text-ink-faint">{key}</dt>
                  <dd className="min-w-0 truncate font-mono text-[10px] text-ink-muted">
                    {String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </li>
  );
}

export function AgentActivityPanel({
  trace,
  error,
  recent,
  onSelectTrace,
}: {
  trace: TraceView | null;
  error: string | null;
  recent: TraceSummaryView[];
  onSelectTrace: (traceId: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const status = trace ? TRACE_STATUS_PRESENTATION[trace.status] : null;

  return (
    <Panel
      title="Agent activity"
      meta={status ? <StatusChip status={status} /> : undefined}
      actions={
        recent.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
            className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] text-ink-muted transition-colors hover:border-accent-soft hover:text-accent"
          >
            {showHistory ? "Hide runs" : "Recent runs"}
          </button>
        ) : undefined
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {showHistory && recent.length > 0 && (
        <ul className="mb-3 divide-y divide-line-soft rounded-lg border border-line">
          {recent.map((run) => {
            const runStatus = TRACE_STATUS_PRESENTATION[run.status];
            return (
              <li key={run.traceId}>
                <button
                  type="button"
                  onClick={() => onSelectTrace(run.traceId)}
                  className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-[10px] text-ink-faint">
                      {formatClockSeconds(run.startedAt)}
                    </span>
                    <span className="ml-2 text-xs text-ink-muted">{run.requestSummary}</span>
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[10px] tracking-[0.1em] ${toneText(runStatus.tone)}`}
                  >
                    {runStatus.symbol} {runStatus.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!trace ? (
        <EmptyState>
          No agent activity yet.
          <br />
          Ask RackHand something and every step appears here as it happens.
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between gap-3 border-b border-line-soft pb-2">
            <p className="min-w-0 truncate text-xs text-ink">
              <span className="font-mono text-[10px] text-ink-faint">REQUEST </span>
              “{trace.requestSummary}”
            </p>
            <span className="shrink-0 font-mono text-[10px] text-ink-faint">
              {formatDuration(trace.durationMs) ?? "in progress"}
            </span>
          </div>

          {trace.events.length === 0 ? (
            <EmptyState>Waiting for the first step…</EmptyState>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto pr-1">
              {trace.events.map((event) => (
                <TraceRow key={event.sequence} event={event} />
              ))}
            </ul>
          )}

          {trace.error && (
            <p className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                {trace.error.code}
              </span>
              <br />
              {trace.error.message}
            </p>
          )}

          {/*
           * A small technical footer, kept away from the operational timeline:
           * useful to a judge, irrelevant to someone running the warehouse.
           * Absent entirely when the SDK reported no metrics.
           */}
          {trace.metrics.modelCalls !== null && (
            <p className="mt-3 font-mono text-[10px] text-ink-faint">
              Model calls {trace.metrics.modelCalls}
              {trace.metrics.totalTokens !== null && ` · tokens ${trace.metrics.totalTokens}`}
              {trace.metrics.modelLatencyMs !== null &&
                ` · model latency ${formatDuration(trace.metrics.modelLatencyMs)}`}
              {` · ${trace.traceId}`}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
