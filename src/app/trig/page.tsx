import type { Metadata } from "next";
import { ForceResetAction } from "@/components/warehouse/admin/force-reset-action";
import { TodayPlanTrigger } from "@/components/warehouse/today-plan-trigger";
import { PageShell } from "@/components/warehouse/views/shell";

export const metadata: Metadata = { title: "Trigger tomorrow’s plan" };

export default function TriggerTodayPlanPage() {
  return (
    <PageShell
      title="RackHand plan trigger"
      intent="Manually start the durable analysis of tomorrow’s enabled Google Sheet plan."
    >
      <div className="flex flex-col items-center gap-6 py-8">
        <TodayPlanTrigger />
        {/*
          Recovery, not routine: kept below the trigger and visually quiet so
          it reads as the thing you reach for when a previous run died.
        */}
        <div className="flex w-full max-w-xl items-center justify-between gap-4 rounded-lg border border-line-soft bg-bg-elevated/60 px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-muted">
            A crashed run can leave bins stuck in RESERVED, CHECKED_OUT or
            AUDITING. Force reset reverts them so the plan can run again.
          </p>
          <ForceResetAction />
        </div>
      </div>
    </PageShell>
  );
}
