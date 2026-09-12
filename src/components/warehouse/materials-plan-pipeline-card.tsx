"use client";

import type { ReactNode } from "react";
import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import type {
  MaterialRequirementView,
  MaterialsPlanCheckView,
} from "@/lib/warehouse/dashboard-types";
import { Panel, StatusChip, toneText } from "./ui";
import { MaterialsPlanStage } from "./materials-plan-card";
import {
  MaterialsCheckStage,
  materialsCheckRunning,
  materialsCheckVerdict,
} from "./materials-check-progress-card";

/**
 * The build-plan answer, as ONE staged process.
 *
 * WHY THIS EXISTS. "What do I need to build a chair?" is answered by two
 * different pieces of machinery — a read-only Materials Planner specialist
 * that produces the requirements list, and approval-gated fulfillment that
 * checks persisted evidence before it moves anything. Historical rows from
 * the retired all-bin stock check can still render as Step 2, but new plans
 * verify only the minimum relevant uncertain bins inside fulfillment.
 *
 * WHAT IT NEVER CLAIMS. There is no live streaming of tool calls from the
 * server today, so nothing here asserts what the model is "currently doing".
 * Step 1's status is derived from a list that has actually arrived; Step 2's
 * progress is a real database row the sweep updates as it finishes each bin.
 * Every state shown is something that has demonstrably happened.
 */

const PLANNER_DONE: StatusPresentation = { label: "DONE", tone: "ok", symbol: "✓" };
const FULFILLMENT_READY: StatusPresentation = { label: "APPROVAL", tone: "warn", symbol: "!" };
const CHECK_RUNNING: StatusPresentation = { label: "RUNNING", tone: "accent", symbol: "●" };
const CHECK_FAILED: StatusPresentation = { label: "NO REPORT", tone: "danger", symbol: "✕" };
const CHECK_SKIPPED: StatusPresentation = { label: "NOT NEEDED", tone: "muted", symbol: "–" };

/**
 * One numbered stage: who does it, what state it is in, and its own body.
 * The connector line is what makes two stages read as one process rather than
 * two stacked cards, so it is drawn for every stage except the last.
 */
function PipelineStage({
  index,
  title,
  actor,
  status,
  last = false,
  children,
}: {
  index: number;
  title: string;
  /** The thing doing the work — named so the operator knows which agent is involved. */
  actor: string;
  status: StatusPresentation;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative pl-8">
      {!last && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-[11px] top-7 w-px bg-line"
        />
      )}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 flex h-[23px] w-[23px] items-center justify-center rounded-full border border-line bg-bg-elevated font-mono text-[10px] ${toneText(
          status.tone,
        )}`}
      >
        {index}
      </span>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-ink">
            Step {index} · {title}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] tracking-[0.08em] text-ink-faint">
            {actor}
          </p>
        </div>
        <StatusChip status={status} className="shrink-0" />
      </div>
      <div className="mt-2">{children}</div>
    </li>
  );
}

export function MaterialsPlanPipelineCard({
  requirements,
  check,
}: {
  /**
   * The planner's list. Comes from the chat reply for the turn that produced
   * it, and from the polled check row afterwards — so the card survives a
   * reload or a later turn without losing what the build actually needs.
   */
  requirements: MaterialRequirementView[];
  /** Historical stock-check row; new plans leave this null. */
  check: MaterialsPlanCheckView | null;
}) {
  // Step 1 is always DONE by the time this card exists at all — it only ever
  // renders once materialsPlan (the chat reply's own {requirements}, however
  // short) or the polled check is present, and both only exist once the
  // planner call has already completed. An empty list is a real, finished
  // answer ("nothing in the catalog is relevant"), not a still-running one.
  const running = check !== null && materialsCheckRunning(check);
  const verdict = check ? materialsCheckVerdict(check) : null;
  // Historical sessions may still have a completed stock-check row from the
  // previous pipeline. New plans go directly to approval-gated fulfillment.
  const nothingToCheck = requirements.length === 0 && check === null;

  const checkStatus: StatusPresentation = verdict
    ? verdict.chip
    : nothingToCheck
      ? CHECK_SKIPPED
      : check === null
        ? FULFILLMENT_READY
        : running
          ? CHECK_RUNNING
          : CHECK_FAILED;

  // The header chip is the whole pipeline's state — the SAME chip step 2
  // carries, so the header can never disagree with the verdict banner below
  // it. Until a report exists it says which stage is still in flight.
  return (
    <Panel
      title="Build plan"
      tone={verdict?.tone === "danger" || verdict?.tone === "warn" ? "attention" : undefined}
      meta={<StatusChip status={checkStatus} />}
    >
      <ol className="space-y-4">
        <PipelineStage
          index={1}
          title="Materials planner"
          actor="Materials planner agent · read-only, catalog-grounded"
          status={PLANNER_DONE}
        >
          <MaterialsPlanStage requirements={requirements} />
        </PipelineStage>

        <PipelineStage
          index={2}
          title={check ? "Stock check" : "Fulfillment"}
          actor={
            check
              ? "Recorded physical stock verification"
              : "RackHand Agent · operator approval required"
          }
          status={checkStatus}
          last
        >
          {check ? (
            <MaterialsCheckStage check={check} />
          ) : nothingToCheck ? (
            <p className="text-xs leading-relaxed text-ink-muted">
              Skipped — the materials planner found nothing in the catalog relevant to this build,
              so there is nothing on the shelf to check.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-ink-muted">
              Ready for evidence-aware fulfillment. After approval, RackHand skips unchanged,
              previously verified bins; if needed, it checks only the minimum relevant uncertain
              bins before retrieving one bin to OUTPUT at a time.
            </p>
          )}
        </PipelineStage>
      </ol>

      <p className="mt-3 font-mono text-[10px] text-ink-faint">
        Planner output is read-only · every fulfillment starts behind operator approval
      </p>
    </Panel>
  );
}
