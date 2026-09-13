"use client";

import type {
  TodayPlanAnalysisRunView,
  TodayPlanAnalysisStage,
} from "@/lib/engineering-plan/analysis-types";
import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import { StatusChip } from "./ui";

const STAGE_LABELS: Record<TodayPlanAnalysisStage, string> = {
  QUEUED: "Queued",
  READING_SHEET: "Reading tomorrow’s Sheet",
  PLANNING_MATERIALS: "Resolving materials",
  CHECKING_EVIDENCE: "Checking inventory evidence",
  AUDITING_BIN: "Moving bin to checkout scan",
  COMPLETE: "Analysis complete",
};

function statusPresentation(run: TodayPlanAnalysisRunView): StatusPresentation {
  if (run.status === "FAILED") return { label: "FAILED", symbol: "×", tone: "danger" };
  if (run.status === "COMPLETED_WITH_ISSUES") {
    return { label: "REPORT READY", symbol: "✓", tone: "warn" };
  }
  if (run.status === "COMPLETED") return { label: "COMPLETE", symbol: "✓", tone: "ok" };
  if (run.status === "QUEUED") return { label: "QUEUED", symbol: "○", tone: "muted" };
  return { label: "LIVE", symbol: "●", tone: "accent" };
}

function readinessPresentation(readiness: NonNullable<TodayPlanAnalysisRunView["result"]>["readiness"]): StatusPresentation {
  if (readiness === "READY") return { label: "READY", symbol: "✓", tone: "ok" };
  if (readiness === "PARTIALLY_READY") return { label: "PARTIALLY READY", symbol: "◐", tone: "warn" };
  if (readiness === "SHORTAGE") return { label: "SHORTAGE", symbol: "!", tone: "warn" };
  if (readiness === "NO_PLAN" || readiness === "NO_MATERIALS") {
    return { label: readiness.replaceAll("_", " "), symbol: "○", tone: "muted" };
  }
  return { label: "REVIEW REQUIRED", symbol: "!", tone: "warn" };
}

function auditIssueReason(reason: string): string {
  switch (reason) {
    case "audit_pending_confirmation":
      return "Confident lower count";
    case "audit_observation_unsafe":
      return "Count was not reliable";
    case "foreign_object_suspected":
      return "Unexpected object detected";
    case "audit_capacity_exceeded":
      return "Observed count exceeded capacity";
    default:
      return reason.replaceAll("_", " ");
  }
}

/** Persistent transcript card for the manually triggered, no-HITL plan diagnosis. */
export function TodayPlanAnalysisCard({ run }: { run: TodayPlanAnalysisRunView }) {
  const running = run.status === "QUEUED" || run.status === "RUNNING";
  const latestEvents = run.events.slice(-6);
  const selectedBins = run.result?.selectedBins ?? [];
  const shortages = run.result?.shortages ?? [];
  const auditIssues = run.result?.auditIssues ?? [];
  // Older completed reports predate persisted skip reasons. In analysis mode,
  // a selected bin that was not audited could only have been selected from
  // trusted evidence, so preserve that useful explanation after deployment.
  const auditedBins = new Set(run.result?.auditedBinCodes ?? []);
  const scanSkips = run.result?.scanSkips ?? selectedBins
    .filter((bin) => !auditedBins.has(bin.binCode))
    .map((bin) => ({
      sku: bin.sku,
      binCode: bin.binCode,
      lastVerifiedAt: null,
      reason: "trusted verification was reused",
    }));

  return (
    <section className="animate-fade-up overflow-hidden rounded-xl border border-accent-soft/50 bg-accent-tint/30">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
            Tomorrow’s build-plan analysis
          </p>
          <p className="mt-1 text-xs text-ink-muted">Google Sheet · {run.workDate}</p>
        </div>
        <StatusChip status={statusPresentation(run)} />
      </header>

      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          {running && <span className="h-2 w-2 animate-glow-pulse rounded-full bg-accent" aria-hidden="true" />}
          <p className="text-sm font-medium text-ink">
            {STAGE_LABELS[run.stage]}
            {run.currentBinCode ? ` · ${run.currentBinCode}` : ""}
          </p>
        </div>

        {run.rows.length > 0 && (
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Tomorrow’s work · {run.rowsFound} row{run.rowsFound === 1 ? "" : "s"}
            </p>
            <div className="mt-2 space-y-1.5">
              {run.rows.slice(0, 4).map((row) => (
                <div key={row.planId} className="rounded-lg border border-line-soft bg-bg/40 px-3 py-2">
                  <p className="truncate text-xs font-medium text-ink">{row.project} · {row.buildTask}</p>
                  <p className="mt-0.5 font-mono text-[9px] text-ink-faint">{row.planId} · {row.priority || "NORMAL"}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {run.requirements.length > 0 && (
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Grounded material requirements
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {run.requirements.map((requirement, index) => (
                <div key={`${requirement.sku}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-bg/40 px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-[10px] text-ink">{requirement.sku}</span>
                  <span className="shrink-0 text-xs font-semibold text-accent">×{requirement.quantity}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {latestEvents.length > 0 && (
          <ol className="space-y-2 border-l border-line pl-3" aria-label="RackHand analysis progress">
            {latestEvents.map((event, index) => {
              const latest = index === latestEvents.length - 1;
              return (
                <li key={event.id} className={latest ? "text-ink" : "text-ink-muted"}>
                  <p className="text-xs leading-relaxed">{event.summary}</p>
                </li>
              );
            })}
          </ol>
        )}

        {run.result && (
          <div className="space-y-3 rounded-lg border border-line bg-bg-elevated p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">Final operations report</p>
              <StatusChip status={readinessPresentation(run.result.readiness)} />
            </div>
            <p className="text-xs leading-relaxed text-ink-muted">{run.result.message}</p>

            {auditIssues.length > 0 && (
              <div className="rounded-lg border border-warn/40 bg-warn-soft p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
                  Audit issues · {auditIssues.length}
                </p>
                <div className="mt-2 space-y-2">
                  {auditIssues.map((issue) => (
                    <div key={`${issue.binCode}-${issue.reason}`}>
                      <p className="font-mono text-[10px] text-ink">
                        {issue.binCode} · {issue.expectedQuantity} recorded → {issue.observedQuantity ?? "unknown"} observed
                        {issue.confidencePercent === null ? "" : ` · ${issue.confidencePercent}%`}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-muted">
                        {auditIssueReason(issue.reason)} · inventory left unchanged
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {scanSkips.length > 0 && (
              <div className="rounded-lg border border-accent-soft/50 bg-accent-tint/40 p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
                  Smart skips · {scanSkips.length} scan{scanSkips.length === 1 ? "" : "s"} saved
                </p>
                <div className="mt-2 space-y-2">
                  {scanSkips.map((skip) => (
                    <div key={`${skip.sku}-${skip.binCode}`}>
                      <p className="font-mono text-[10px] text-ink">
                        {skip.binCode} · {skip.sku}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-muted">
                        Scan skipped — trusted verification
                        {skip.lastVerifiedAt ? ` from ${skip.lastVerifiedAt.slice(0, 10)}` : ""} reused; no inventory change since.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedBins.length > 0 && (
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-success">
                  Ready for operation · {selectedBins.length} bin{selectedBins.length === 1 ? "" : "s"}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {selectedBins.map((bin) => (
                    <div key={`${bin.sku}-${bin.binCode}`} className="flex items-center justify-between gap-3 rounded-md border border-success/30 bg-success-soft px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] text-ink">{bin.binCode} · {bin.sku}</p>
                        <p className="mt-0.5 text-[10px] text-ink-muted">
                          {bin.recordedQuantity} recorded · {bin.requiredQuantity} required
                        </p>
                      </div>
                      <StatusChip status={{ label: "READY", symbol: "✓", tone: "ok" }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {shortages.length > 0 && (
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-warn">
                  Not used in this plan · {shortages.length} material{shortages.length === 1 ? "" : "s"}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {shortages.map((shortage) => (
                    <div key={shortage.sku} className="flex items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[10px] text-ink">{shortage.sku}</p>
                        <p className="mt-0.5 text-[10px] text-ink-muted">
                          {shortage.available} shelf-available · {shortage.required} required
                        </p>
                      </div>
                      <StatusChip status={{ label: "NOT USED", symbol: "–", tone: "warn" }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedBins.length === 0 && shortages.length === 0 && (
              <p className="text-xs text-ink-faint">No operational bin selection was produced.</p>
            )}
            {run.result.auditedBinCodes.length > 0 && (
              <p className="font-mono text-[9px] text-ink-faint">
                SCANNED AND RETURNED · {run.result.auditedBinCodes.join(", ")}
              </p>
            )}
          </div>
        )}

        {run.status === "FAILED" && run.errorMessage && (
          <p className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            {run.errorMessage}
          </p>
        )}

        <p className="font-mono text-[9px] leading-relaxed text-ink-faint">
          Audit-selected bins move shelf → checkout scan → same shelf slot · no operator approval
        </p>
      </div>
    </section>
  );
}
