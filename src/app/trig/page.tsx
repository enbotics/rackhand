import type { Metadata } from "next";
import { TodayPlanTrigger } from "@/components/warehouse/today-plan-trigger";
import { PageShell } from "@/components/warehouse/views/shell";

export const metadata: Metadata = { title: "Trigger today’s plan" };

export default function TriggerTodayPlanPage() {
  return (
    <PageShell
      title="RackHand plan trigger"
      intent="Manually start the durable analysis of today’s enabled Google Sheet plan."
    >
      <div className="flex justify-center py-8">
        <TodayPlanTrigger />
      </div>
    </PageShell>
  );
}
