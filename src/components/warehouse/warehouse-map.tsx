"use client";

import type { BinView } from "@/lib/warehouse/dashboard-types";
import { BIN_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { parseBinCode } from "@/lib/warehouse/types";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Panel, StatusChip } from "./ui";

/**
 * The digital warehouse — the storage bay as it actually is.
 *
 * LAID OUT LIKE THE SHELF. Bins are grouped into beds and the beds are drawn
 * top-down, so bed 6 is at the top of the panel exactly as it is at the top of
 * the rack. An operator glancing between the screen and the physical shelf
 * should not have to translate.
 *
 * Every value comes from the server's snapshot of the Bin and Inventory
 * tables. Occupancy is never inferred from a gantry animation, from an earlier
 * React state, or from what the operator just scanned: those would all show a
 * warehouse the database does not agree with.
 */

/** Groups bins by bed, highest bed first, so the panel mirrors the rack. */
function byBed(bins: BinView[]): Array<{ bed: number | null; bins: BinView[] }> {
  const beds = new Map<number | null, BinView[]>();
  for (const bin of bins) {
    // A code that does not parse still has to appear — silently dropping a bin
    // would hide stock. It collects under a null bed instead.
    const bed = parseBinCode(bin.code)?.bed ?? null;
    beds.set(bed, [...(beds.get(bed) ?? []), bin]);
  }
  return [...beds.entries()]
    .sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1))
    .map(([bed, bins]) => ({ bed, bins }));
}
export function WarehouseMap({
  bins,
  loading,
  error,
  onRetry,
  /** Highlighted while the machine is somewhere other than idle. */
  activeLocation,
  onManageBins,
  onSelectBin,
}: {
  bins: BinView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  activeLocation?: string | null;
  /** Presentational callback — the actual CRUD UI/state lives in the composing view. */
  onManageBins?: () => void;
  /** Opens the bin-detail modal for a click on a card. */
  onSelectBin?: (bin: BinView) => void;
}) {
  return (
    <Panel
      title="Digital warehouse"
      meta={
        <span className="font-mono text-[10px] text-ink-faint">
          {bins.length > 0 ? `${bins.length} bins` : ""}
        </span>
      }
      actions={
        onManageBins && (
          <button type="button" onClick={onManageBins} className={BUTTON_VARIANTS.secondary}>
            Manage bins
          </button>
        )
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
        <div className="flex flex-col gap-2">
          {byBed(bins).map((row) => (
            <div key={row.bed ?? "unplaced"} className="flex items-stretch gap-2">
              <span className="flex w-10 shrink-0 items-center justify-end pr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                {row.bed === null ? "—" : `bed ${row.bed}`}
              </span>
              <div
                className="grid flex-1 gap-2"
                style={{ gridTemplateColumns: `repeat(${row.bins.length}, minmax(0, 1fr))` }}
              >
                {row.bins.map((bin) => {
                  const status = BIN_STATUS_PRESENTATION[bin.status];
                  const active = activeLocation === bin.code;
                  return (
                    <button
                      key={bin.binId}
                      type="button"
                      onClick={() => onSelectBin?.(bin)}
                      disabled={!onSelectBin}
                      className={`flex min-h-[84px] flex-col gap-1 rounded-lg border bg-bg-elevated p-2 text-left transition-colors ${
                        active ? "border-accent" : "border-line"
                      } ${onSelectBin ? "cursor-pointer hover:border-accent-soft" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold tracking-wider text-ink">
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
                        <ul className="mt-auto space-y-1">
                          {bin.contents.map((item) => (
                            <li key={item.partId} className="flex min-w-0 items-center gap-1.5">
                              {item.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={item.imageUrl}
                                  alt={item.canonicalName}
                                  className="h-8 w-8 shrink-0 rounded-md border border-line object-cover"
                                />
                              ) : (
                                <div className="h-8 w-8 shrink-0 rounded-md border border-dashed border-line" />
                              )}
                              <div className="min-w-0">
                                <p className="truncate font-mono text-[11px] text-ink">{item.sku}</p>
                                <p className="font-mono text-[10px] text-ink-muted">
                                  Qty: {item.quantity}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
