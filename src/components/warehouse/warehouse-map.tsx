"use client";

import type { BinView } from "@/lib/warehouse/dashboard-types";
import { BIN_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, ErrorNote, Panel, StatusChip } from "./ui";

/**
 * The digital warehouse — the six bins as they actually are.
 *
 * Every value drawn here comes from the server's snapshot of the Bin and
 * Inventory tables. Occupancy is never inferred from a gantry animation, from
 * an earlier React state, or from what the operator just scanned: those would
 * all show a warehouse the database does not agree with.
 */
export function WarehouseMap({
  bins,
  loading,
  error,
  onRetry,
  /** Highlighted while the machine is somewhere other than idle. */
  activeLocation,
}: {
  bins: BinView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  activeLocation?: string | null;
}) {
  return (
    <Panel
      title="Digital warehouse"
      meta={
        <span className="font-mono text-[10px] text-ink-faint">
          {bins.length > 0 ? `${bins.length} bins` : ""}
        </span>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorNote onRetry={onRetry}>Unable to load bin state.</ErrorNote>
        </div>
      )}

      {bins.length === 0 ? (
        loading ? (
          <EmptyState>Loading bin state…</EmptyState>
        ) : (
          <EmptyState>No bins are configured in the warehouse database.</EmptyState>
        )
      ) : (
        <div className="grid grid-cols-3 gap-2.5">
          {bins.map((bin) => {
            const status = BIN_STATUS_PRESENTATION[bin.status];
            const active = activeLocation === bin.code;
            return (
              <div
                key={bin.binId}
                className={`flex min-h-[104px] flex-col gap-2 rounded-lg border bg-bg-elevated p-3 transition-colors ${
                  active ? "border-accent" : "border-line"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold tracking-wider text-ink">
                    {bin.code}
                  </span>
                  {active && (
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent">
                      active
                    </span>
                  )}
                </div>

                <StatusChip status={status} className="self-start" />

                {bin.contents.length === 0 ? (
                  <p className="mt-auto text-[11px] text-ink-faint">Empty</p>
                ) : (
                  <ul className="mt-auto space-y-0.5">
                    {bin.contents.map((item) => (
                      <li key={item.partId} className="min-w-0">
                        <p className="truncate font-mono text-[11px] text-ink">{item.sku}</p>
                        <p className="font-mono text-[10px] text-ink-muted">Qty: {item.quantity}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
