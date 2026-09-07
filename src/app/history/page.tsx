import type { Metadata } from "next";
import { HistoryView } from "@/components/warehouse/views/history-view";

export const metadata: Metadata = {
  title: "History — Agentic Spare Parts Warehouse",
  description: "Warehouse movement history and local scan history.",
};

export default function HistoryPage() {
  return <HistoryView />;
}
