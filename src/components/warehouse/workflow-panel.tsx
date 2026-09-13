"use client";

import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import { WORKFLOW_STEP_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, Panel, StatusChip, toneText as panelToneText } from "./ui";

/**
 * Compact view of the last Strands graph run (Milestone 11).
 *
 * This is the orchestration story made visible: the agent chose a tool, a
 * person approved it, and then a developer-defined Strands Graph walked a
 * fixed sequence of deterministic stages before anything physical happened.
 * A judge can read the stage list and see exactly where a workflow stopped.
 *
 * It is NOT tracing. There are no durations, no token counts, no model events
 * and no prompts — Milestone 12 owns that. Everything shown here is
 * server-composed workflow state; the browser never imports the Strands SDK.
 */
export function WorkflowPanel({ workflow }: { workflow: WarehouseGraphResult | null }) {
  if (!workflow) {
    return (
      <Panel title="Workflow">
        <EmptyState>
          No warehouse workflow has run yet.
          <br />
          Approved putaways and retrievals run through a Strands graph and appear here.
        </EmptyState>
      </Panel>
    );
  }

  const outcome =
    workflow.status === "COMPLETED"
      ? WORKFLOW_STEP_PRESENTATION.COMPLETED
      : workflow.status === "BLOCKED"
        ? WORKFLOW_STEP_PRESENTATION.BLOCKED
        : WORKFLOW_STEP_PRESENTATION.FAILED;

  return (
    <Panel
      title={`${workflow.workflow} workflow`}
      meta={<StatusChip status={{ ...outcome, label: workflow.status }} />}
    >
      <ol className="space-y-1.5">
        {workflow.steps.map((step) => {
          const presentation = WORKFLOW_STEP_PRESENTATION[step.status];
          return (
            <li key={step.nodeId} className="flex items-baseline gap-2.5">
              <span
                aria-hidden="true"
                className={`w-3 shrink-0 text-center font-mono text-xs ${panelToneText(presentation.tone)}`}
              >
                {presentation.symbol}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-3">
                  <span
                    className={`text-[13px] ${
                      step.status === "SKIPPED" || step.status === "PENDING"
                        ? "text-ink-faint"
                        : "text-ink"
                    }`}
                  >
                    {step.label}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[11px] tracking-[0.1em] ${panelToneText(presentation.tone)}`}
                  >
                    {presentation.label}
                  </span>
                </p>
                {step.summary && (
                  <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-muted">
                    {step.summary}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {workflow.status !== "COMPLETED" && (
        <p
          className={`mt-3 rounded-lg border px-4 py-3 text-sm leading-6 ${
            workflow.status === "BLOCKED"
              ? "border-warn/40 bg-warn-soft text-warn"
              : "border-danger/40 bg-danger-soft text-danger"
          }`}
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.12em]">
            {workflow.reason}
          </span>
          <br />
          {workflow.message}
        </p>
      )}

      <p className="mt-3 font-mono text-[11px] text-ink-muted">
        RackHand follows each verified step in order.
      </p>
    </Panel>
  );
}
