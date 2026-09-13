"use client";

import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import type {
  InventoryRowView,
  MaterialRequirementView,
  MaterialsPlanCheckView,
} from "@/lib/warehouse/dashboard-types";
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
}) {
  // An empty list is a real, finished answer, not a still-running one.
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
            {jobTitle} · 1/{requirements.length}
          </p>
          <ol className="mt-2 space-y-1.5">
            {requirements.map((requirement, index) => {
              const positions = materialBinPositions(requirement, inventory);
              return <li key={`${requirement.sku}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
                <span className={index === 0 && !check ? "font-medium text-ink" : "text-ink-muted"}>
                  {materialName(requirement)}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent">
                  Bin {positions.length > 0 ? positions.join(" + ") : "—"}
                </span>
                <span className={`shrink-0 font-mono text-xs ${toneText(check ? "ok" : index === 0 ? "warn" : "muted")}`}>
                  {requirement.quantity}× {check ? "✓" : index === 0 ? "→" : "○"}
                </span>
              </li>;
            })}
          </ol>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-y border-line-soft py-3 font-mono text-[9px] uppercase tracking-[0.12em]">
        <span className={toneText("ok")}>✓ Plan</span>
        <span className={toneText(check ? "ok" : "warn")}>{check ? "✓" : "→"} Fulfill</span>
        <span className={toneText(check ? "accent" : "muted")}>{check ? "→" : "○"} Verify</span>
        <span className={toneText(verdict ? verdict.chip.tone : "muted")}>{verdict ? verdict.chip.symbol : "○"} Result</span>
      </div>

      <div className="mt-3">
        {check ? (
          <MaterialsCheckStage check={check} />
        ) : nothingToCheck ? (
          <p className="text-xs text-ink-muted">No stocked materials matched this build.</p>
        ) : (
          <p className="text-xs text-ink-muted">
            {requirements.length} material type{requirements.length === 1 ? " is" : "s are"} ready for checkout.
          </p>
        )}
      </div>
    </Panel>
  );
}
