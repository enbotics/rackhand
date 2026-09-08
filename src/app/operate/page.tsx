import type { Metadata } from "next";
import { OperateView } from "@/components/warehouse/views/operate";

export const metadata: Metadata = {
  title: "Operate — Agentic Spare Parts Warehouse",
  description: "Scan a part, identify it against the catalog, and approve putaway or retrieval.",
};

export default function OperatePage() {
  return <OperateView />;
}
