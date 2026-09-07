import type { Metadata } from "next";
import { ActivityView } from "@/components/warehouse/views/activity-view";

export const metadata: Metadata = {
  title: "Activity — Agentic Spare Parts Warehouse",
  description: "Agent execution traces. Observational only.",
};

export default function ActivityPage() {
  return <ActivityView />;
}
