"use client";

import { GantryStatusPanel } from "../gantry-status";
import { InventoryPanel } from "../inventory-panel";
import { WarehouseMap } from "../warehouse-map";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * WAREHOUSE — where everything is right now.
 *
 * Every panel here is authoritative: bins and stock come from the warehouse
 * database, machine state from the GantryController. Nothing on this page is
 * inferred from what the browser saw earlier.
 */
export function WarehouseView() {
  const session = useWarehouseSession();

  return (
    <PageShell
      title="Warehouse"
      intent="Authoritative state: what each bin holds, what is in stock, and what the machine is doing."
      footer="Read from the warehouse database and the gantry controller. Bin status is stored, never inferred from whether a bin happens to hold stock."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-8">
          <WarehouseMap
            bins={session.bins}
            loading={session.loading}
            error={session.overviewError}
            onRetry={session.refresh}
            activeLocation={
              session.gantry?.state !== "IDLE" ? session.gantry?.currentLocation : null
            }
          />
          <InventoryPanel
            inventory={session.inventory}
            loading={session.loading}
            error={session.overviewError}
            onRetry={session.refresh}
          />
        </div>

        <div className="lg:col-span-4">
          <GantryStatusPanel
            status={session.gantry}
            error={session.gantryError}
            activeMovement={session.activeMovement}
          />
        </div>
      </div>
    </PageShell>
  );
}
