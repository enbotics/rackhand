"use client";

import { useState } from "react";
import type { TraceEventView, TraceSummaryView, TraceView } from "@/lib/observability/types";
import {
  TRACE_STATUS_PRESENTATION,
  formatClockSeconds,
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
  if (event.type === "INVENTORY_UPDATED" || event.type === "BIN_STATUS_UPDATED") {
    return "RESULT";
  }
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

const STAGE_ORDER: ActivityStage[] = ["OBSERVE", "DECIDE", "ACT", "RESULT"];

function eventPriority(event: TraceEventView): number {
  if (event.type === "INVENTORY_UPDATED") return 100;
  if (event.type === "BIN_STATUS_UPDATED") return 95;
  if (event.type.startsWith("APPROVAL_")) return 90;
  if (event.category === "GANTRY" || event.type.startsWith("MOVEMENT_")) return 85;
  if (event.category === "TOOL") return 75;
  return 20;
}

function activityEvents(events: TraceEventView[]): TraceEventView[] {
  const selected = new Map<ActivityStage, TraceEventView>();
  for (const event of events) {
    const stage = activityStage(event);
    const current = selected.get(stage);
    if (!current || eventPriority(event) >= eventPriority(current)) selected.set(stage, event);
  }
  return STAGE_ORDER.flatMap((stage) => {
    const event = selected.get(stage);
    return event ? [event] : [];
  });
}

function conciseSummary(event: TraceEventView): string {
  if (event.type === "INVENTORY_UPDATED") return "Inventory updated";
  if (event.type === "BIN_STATUS_UPDATED") return "Bin status updated";
  if (event.type === "APPROVAL_APPROVED") return "Continue job";
  if (event.type === "APPROVAL_REQUIRED") return "Operator approval needed";
  if (event.type === "APPROVAL_DENIED") return "Job cancelled";
  if (event.category === "GANTRY" || event.type.startsWith("MOVEMENT_")) return "Bin moved";
  if (event.category === "TOOL") return "Inventory checked";
  if (event.type.endsWith("FAILED") || event.type === "GRAPH_BLOCKED") return "Job needs attention";
  if (event.type.endsWith("COMPLETED")) return "Job completed";
  return event.summary.replace(/[.!]$/, "").slice(0, 72);
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
 * It is a status trail, not a log viewer: at most one concise event is shown
 * for each operator stage. Nothing on this panel can cause a physical action.
 */
function TraceRow({ event }: { event: TraceEventView }) {
  const stage = ACTIVITY_STAGES[activityStage(event)];

  return (
    <li className="grid grid-cols-[92px_1fr] items-baseline gap-3 border-b border-line-soft py-2 last:border-b-0">
      <span className={`font-mono text-[10px] tracking-[0.13em] ${toneText(stage.tone)}`}>
        <span aria-hidden="true" className="mr-1">{stage.symbol}</span>
        {stage.label}
      </span>
      <p className="min-w-0 truncate text-sm text-ink">{conciseSummary(event)}</p>
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
      title="Activity"
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
          No activity yet.
          <br />
          Ask RackHand something and every step appears here as it happens.
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 border-b border-line-soft pb-2">
            <p className="min-w-0 truncate text-xs text-ink">
              <span className="font-mono text-[10px] text-ink-faint">REQUEST </span>
              “{trace.requestSummary}”
            </p>
          </div>

          {trace.events.length === 0 ? (
            <EmptyState>Waiting for the first step…</EmptyState>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto pr-1">
              {activityEvents(trace.events).map((event) => (
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
        </>
      )}
    </Panel>
  );
}
