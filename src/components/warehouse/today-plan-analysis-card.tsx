"use client";

import type {
  TodayPlanAnalysisRunView,
  TodayPlanAnalysisStage,
} from "@/lib/engineering-plan/analysis-types";
import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import { StatusChip } from "./ui";

const STAGE_LABELS: Record<TodayPlanAnalysisStage, string> = {
  QUEUED: "Queued",
  READING_SHEET: "Reading today’s Sheet",
  PLANNING_MATERIALS: "Resolving materials",
  CHECKING_EVIDENCE: "Checking inventory evidence",
  AUDITING_BIN: "Verifying a bin",
  COMPLETE: "Analysis complete",
};

function statusPresentation(run: TodayPlanAnalysisRunView): StatusPresentation {
  if (run.status === "FAILED") return { label: "FAILED", symbol: "×", tone: "danger" };
  if (run.status === "COMPLETED_WITH_ISSUES") {
    return { label: "NEEDS REVIEW", symbol: "!", tone: "warn" };
  }
  if (run.status === "COMPLETED") return { label: "COMPLETE", symbol: "✓", tone: "ok" };
  if (run.status === "QUEUED") return { label: "QUEUED", symbol: "○", tone: "muted" };
  return { label: "LIVE", symbol: "●", tone: "accent" };
}

function readinessPresentation(readiness: NonNullable<TodayPlanAnalysisRunView["result"]>["readiness"]): StatusPresentation {
  if (readiness === "READY") return { label: "READY", symbol: "✓", tone: "ok" };
  if (readiness === "SHORTAGE") return { label: "SHORTAGE", symbol: "!", tone: "warn" };
  if (readiness === "NO_PLAN" || readiness === "NO_MATERIALS") {
    return { label: readiness.replaceAll("_", " "), symbol: "○", tone: "muted" };
  }
  return { label: "REVIEW REQUIRED", symbol: "!", tone: "warn" };
}

/** Persistent transcript card for the manually triggered, no-HITL plan diagnosis. */
export function TodayPlanAnalysisCard({ run }: { run: TodayPlanAnalysisRunView }) {
  const running = run.status === "QUEUED" || run.status === "RUNNING";
  const latestEvents = run.events.slice(-6);

  return (
    <section className="animate-fade-up overflow-hidden rounded-xl border border-accent-soft/50 bg-accent-tint/30">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
            Today’s build-plan analysis
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
              Today’s work · {run.rowsFound} row{run.rowsFound === 1 ? "" : "s"}
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
          <div className="rounded-lg border border-line bg-bg-elevated p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">Final diagnosis</p>
              <StatusChip status={readinessPresentation(run.result.readiness)} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">{run.result.message}</p>
            {run.result.auditedBinCodes.length > 0 && (
              <p className="mt-2 font-mono text-[9px] text-ink-faint">
                VERIFIED BINS · {run.result.auditedBinCodes.join(", ")}
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
          Analysis and targeted verification only · no material is retrieved · no operator approval is requested
        </p>
      </div>
    </section>
  );
}
