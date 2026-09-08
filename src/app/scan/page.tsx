import type { Metadata } from "next";
import { OperateView } from "@/components/warehouse/views/operate";

export const metadata: Metadata = {
  title: "Stationary Scan — Agentic Spare Parts Warehouse",
  description: "Camera scanning, catalog identification and approved warehouse actions.",
};

export default function ScanPage() {
  return <OperateView />;
}
