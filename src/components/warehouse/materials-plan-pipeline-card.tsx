"use client";

import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import type {
  InventoryRowView,
  MaterialRequirementView,
  MaterialsPlanCheckView,
} from "@/lib/warehouse/dashboard-types";
import type {
  ApprovalOutcome,
  ApprovalSummaryView,
  PendingApprovalView,
} from "./state";
import { Panel, StatusChip, toneText } from "./ui";
import {
  MaterialsCheckStage,
  materialsCheckRunning,
  materialsCheckVerdict,
} from "./materials-check-progress-card";

/**
 * The build-plan answer, as ONE staged process.
 *
 * WHY THIS EXISTS. "What do I need to build a chair?" is answered by two
 * different pieces of machinery — planning and approval-gated fulfillment.
 * The operator sees one compact job card and four plain-language stages.
 *
 * WHAT IT NEVER CLAIMS. There is no live streaming of tool calls from the
 * server today, so nothing here asserts what the model is "currently doing".
 * Every state shown is derived from data that has demonstrably arrived.
 */

const FULFILLMENT_READY: StatusPresentation = { label: "APPROVAL", tone: "warn", symbol: "!" };
const CHECK_RUNNING: StatusPresentation = { label: "RUNNING", tone: "accent", symbol: "●" };
const CHECK_FAILED: StatusPresentation = { label: "NO REPORT", tone: "danger", symbol: "✕" };
const CHECK_SKIPPED: StatusPresentation = { label: "NOT NEEDED", tone: "muted", symbol: "–" };
const JOB_RUNNING: StatusPresentation = { label: "RUNNING", tone: "accent", symbol: "●" };
const JOB_DONE: StatusPresentation = { label: "DONE", tone: "ok", symbol: "✓" };

export interface MaterialsJobProgress {
  activeIndex: number;
  completedCount: number;
  stage: "FULFILL" | "VERIFY" | "RESULT";
  complete: boolean;
  started: boolean;
}

/** Derive display progress only from the server-carried fulfillment queue. */
export function materialsJobProgress(
  requirementCount: number,
  approval: PendingApprovalView | null,
  outcome: ApprovalOutcome | null,
  workflow: WarehouseGraphResult | null = null,
): MaterialsJobProgress {
  const summary: ApprovalSummaryView | null = approval?.summary ?? outcome?.summary ?? null;
  const total = Math.max(1, summary?.fulfillmentTotal ?? requirementCount);
  const queueLength = summary?.fulfillmentQueue?.length;
  const chained = typeof summary?.fulfillmentTotal === "number" && queueLength !== undefined;
  const activeIndex = chained
    ? Math.max(0, Math.min(total - queueLength - 1, requirementCount - 1))
    : 0;
  const finalReturnSettled = Boolean(
    chained &&
      summary?.action === "PUTAWAY" &&
      queueLength === 0 &&
      outcome?.kind === "SETTLED" &&
      workflow?.workflow === "PUTAWAY" &&
      workflow.status === "COMPLETED",
  );
  const stage = finalReturnSettled
    ? "RESULT" as const
    : summary?.action === "PUTAWAY"
      ? "VERIFY" as const
      : "FULFILL" as const;

  return {
    activeIndex: finalReturnSettled ? Math.max(0, requirementCount - 1) : activeIndex,
    completedCount: finalReturnSettled ? requirementCount : activeIndex,
    stage,
    complete: finalReturnSettled,
    started: Boolean(
      summary &&
        (summary.action !== "MATERIALS_FULFILLMENT" || outcome?.kind === "EXECUTING"),
    ),
  };
}

function materialName(requirement: MaterialRequirementView): string {
  const sku = requirement.sku.toUpperCase();
  if (sku.includes("TMC") || sku.includes("MOTOR") || sku.includes("DRIVER")) return "Motor driver";
  if (sku.includes("V-GROOVE") || sku.includes("WHEEL-KIT")) return "Mounting kit";
  if (sku.includes("SPACER")) return "Spacers";
  return requirement.category || requirement.sku.replaceAll("-", " ");
}

function materialBinPositions(
  requirement: MaterialRequirementView,
  inventory: InventoryRowView[],
): string[] {
  const row = inventory.find(
    (candidate) => candidate.sku.toUpperCase() === requirement.sku.toUpperCase(),
  );
  return [...new Set(
    (row?.locations ?? [])
      .filter((location) => location.quantity > 0)
      .map((location) => location.binCode),
  )].sort((left, right) => left.localeCompare(right));
}

export function MaterialsPlanPipelineCard({
  requirements,
  check,
  inventory = [],
  approval = null,
  outcome = null,
  workflow = null,
}: {
  /**
   * The planner's list. Comes from the chat reply for the turn that produced
   * it, and from the polled check row afterwards — so the card survives a
   * reload or a later turn without losing what the build actually needs.
   */
  requirements: MaterialRequirementView[];
  /** Historical stock-check row; new plans leave this null. */
  check: MaterialsPlanCheckView | null;
  /** Current database-backed locations; the Sheet never decides bin position. */
  inventory?: InventoryRowView[];
  /** Current server-owned decision in this materials fulfillment chain. */
  approval?: PendingApprovalView | null;
  /** Most recently settled decision; retains final completion state. */
  outcome?: ApprovalOutcome | null;
  /** Latest server-composed graph proves whether the physical hop completed. */
  workflow?: WarehouseGraphResult | null;
}) {
  // An empty list is a real, finished answer, not a still-running one.
  const running = check !== null && materialsCheckRunning(check);
  const verdict = check ? materialsCheckVerdict(check) : null;
  // Historical sessions may still have a completed stock-check row from the
  // previous pipeline. New plans go directly to approval-gated fulfillment.
  const nothingToCheck = requirements.length === 0 && check === null;
  const job = materialsJobProgress(requirements.length, approval, outcome, workflow);

  const checkStatus: StatusPresentation = verdict
    ? verdict.chip
    : nothingToCheck
      ? CHECK_SKIPPED
      : check === null
        ? job.complete
          ? JOB_DONE
          : job.started
            ? JOB_RUNNING
            : FULFILLMENT_READY
        : running
          ? CHECK_RUNNING
          : CHECK_FAILED;
  const jobTitle = requirements.some((requirement) => {
    const sku = requirement.sku.toUpperCase();
    return sku.includes("TMC") || sku.includes("MOTOR") || sku.includes("DRIVER");
  }) ? "Control module" : "Materials job";

  // The header chip summarizes the latest confirmed stage.
  return (
    <Panel
      title="Build plan"
      tone={verdict?.tone === "danger" || verdict?.tone === "warn" ? "attention" : undefined}
      meta={<StatusChip status={checkStatus} />}
    >
      {requirements.length > 0 ? (
        <div className="rounded-lg border border-accent-soft/40 bg-bg-elevated p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted">
            {jobTitle} · {job.complete ? requirements.length : job.activeIndex + 1}/{requirements.length}
          </p>
          <ol className="mt-2 space-y-1.5">
            {requirements.map((requirement, index) => {
              const positions = materialBinPositions(requirement, inventory);
              const complete = check !== null || job.complete || index < job.completedCount;
              const active = check === null && !job.complete && index === job.activeIndex;
              return <li key={`${requirement.sku}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                <span className={active ? "font-medium text-ink" : "text-ink-muted"}>
                  {materialName(requirement)}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent">
                  Bin {positions.length > 0 ? positions.join(" + ") : "—"}
                </span>
                <span className={`shrink-0 font-mono text-xs ${toneText(complete ? "ok" : active ? "warn" : "muted")}`}>
                  {requirement.quantity}× {complete ? "✓" : active ? "→" : "○"}
                </span>
              </li>;
            })}
          </ol>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-y border-line-soft py-3 font-mono text-[9px] uppercase tracking-[0.12em]">
        <span className={toneText("ok")}>✓ Plan</span>
        <span className={toneText(check || job.stage !== "FULFILL" ? "ok" : "warn")}>
          {check || job.stage !== "FULFILL" ? "✓" : "→"} Fulfill
        </span>
        <span className={toneText(job.stage === "RESULT" ? "ok" : check || job.stage === "VERIFY" ? "accent" : "muted")}>
          {job.stage === "RESULT" ? "✓" : check || job.stage === "VERIFY" ? "→" : "○"} Verify
        </span>
        <span className={toneText(job.complete ? "ok" : verdict ? verdict.chip.tone : "muted")}>
          {job.complete ? "✓" : verdict ? verdict.chip.symbol : "○"} Result
        </span>
      </div>

      <div className="mt-3">
        {check ? (
          <MaterialsCheckStage check={check} />
        ) : nothingToCheck ? (
          <p className="text-xs text-ink-muted">No stocked materials matched this build.</p>
        ) : job.complete ? (
          <p className="text-xs text-ok">All {requirements.length} material types completed.</p>
        ) : job.stage === "VERIFY" ? (
          <p className="text-xs text-ink-muted">
            Return and verify bin {job.activeIndex + 1} of {requirements.length}.
          </p>
        ) : job.started ? (
          <p className="text-xs text-ink-muted">
            Retrieving bin {job.activeIndex + 1} of {requirements.length}.
          </p>
        ) : (
          <p className="text-xs text-ink-muted">
            Ready to start · {requirements.length} bins · {requirements.length} required parts
          </p>
        )}
      </div>
    </Panel>
  );
}
