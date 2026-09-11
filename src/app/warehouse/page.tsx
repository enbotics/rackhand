import type { Metadata } from "next";
import { WarehouseView } from "@/components/warehouse/views/warehouse-view";

export const metadata: Metadata = {
  title: "Warehouse",
  description: "Authoritative bin, inventory and gantry state.",
};

export default function WarehousePage() {
  return <WarehouseView />;
}
