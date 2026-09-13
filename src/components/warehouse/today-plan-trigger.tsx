"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWarehouseSession } from "./session";
import { BUTTON_VARIANTS, ErrorNote, Panel, StatusChip } from "./ui";

export function TodayPlanTrigger() {
  const router = useRouter();
  const session = useWarehouseSession();
  const run = session.todayPlanAnalysis;
  const running = run?.status === "QUEUED" || run?.status === "RUNNING";

  const start = async () => {
    const started = await session.triggerTodayPlanAnalysis();
    if (started) router.push("/");
  };

  return (
    <Panel title="Manual RackHand trigger" className="w-full max-w-xl">
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-ink">Analyze tomorrow’s Google Sheet plan</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            RackHand will read tomorrow’s enabled rows, resolve catalog materials, reuse trustworthy
            inventory evidence, and audit only bins whose evidence needs refreshing.
          </p>
        </div>

        {run && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2">
            <span className="text-xs text-ink-muted">Latest run · {run.workDate}</span>
            <StatusChip status={running
              ? { label: run.status, symbol: "●", tone: "accent" }
              : run.status === "FAILED"
                ? { label: "FAILED", symbol: "×", tone: "danger" }
                : { label: "FINISHED", symbol: "✓", tone: "ok" }} />
          </div>
        )}

        {session.todayPlanAnalysisError && (
          <ErrorNote>{session.todayPlanAnalysisError}</ErrorNote>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void start()}
            disabled={session.todayPlanAnalysisTriggering || running}
            className={BUTTON_VARIANTS.primary}
          >
            {session.todayPlanAnalysisTriggering
              ? "Starting RackHand…"
              : running
                ? "Analysis already running"
                : "Analyze tomorrow’s plan"}
          </button>
          <Link href="/" className={BUTTON_VARIANTS.secondary}>
            View RackHand progress
          </Link>
        </div>
      </div>
    </Panel>
  );
}
