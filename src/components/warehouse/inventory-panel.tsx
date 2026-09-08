"use client";

import { useState } from "react";
import type { InventoryRowView } from "@/lib/warehouse/dashboard-types";
import { filterInventory, formatLocations } from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, ErrorNote, Panel } from "./ui";

/**
 * Authoritative stock, straight from the warehouse database.
 *
 * The quantities and the bin lists are computed server-side
 * (dashboard-service.ts) and rendered verbatim. The search box filters what is
 * already on screen and nothing else — it never re-asks the warehouse a
 * different question, so "no results" can only ever mean "nothing here
 * matches", never "no stock".
 */
export function InventoryPanel({
  inventory,
  loading,
  error,
  onRetry,
  contained = false,
}: {
  inventory: InventoryRowView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  contained?: boolean;
}) {
  const [query, setQuery] = useState("");
  const rows = filterInventory(inventory, query);
  const units = inventory.reduce((sum, row) => sum + row.totalQuantity, 0);

  return (
    <Panel
      title="Inventory"
      className={contained ? "h-full min-h-0 overflow-hidden" : ""}
      bodyClassName={contained ? "flex min-h-0 flex-col" : ""}
      meta={
        <span className="font-mono text-[10px] text-ink-faint">
          {inventory.length} {inventory.length === 1 ? "part" : "parts"} · {units} units
        </span>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorNote onRetry={onRetry}>Unable to load inventory.</ErrorNote>
        </div>
      )}

      {inventory.length > 0 && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search inventory by SKU, name or category…"
          aria-label="Search inventory"
          className="mb-3 w-full shrink-0 rounded-lg border border-line bg-bg-elevated px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
      )}

      {inventory.length === 0 ? (
        loading ? (
          <EmptyState>Loading inventory…</EmptyState>
        ) : (
          <EmptyState>
            No inventory stored yet.
            <br />
            Scan and put away a known catalog part to get started.
          </EmptyState>
        )
      ) : rows.length === 0 ? (
        <EmptyState>No stored part matches “{query}”.</EmptyState>
      ) : (
        <ul tabIndex={contained ? 0 : undefined} aria-label="Stored inventory" className={`divide-y divide-line-soft ${contained ? "min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" : ""}`}>
          {rows.map((row) => (
            <li key={row.partId} className="flex items-baseline justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-medium text-ink">{row.sku}</p>
                <p className="truncate text-[11px] text-ink-muted">{row.canonicalName}</p>
                {row.category && (
                  <p className="truncate font-mono text-[10px] text-ink-faint">{row.category}</p>
                )}
              </div>
              <div className="max-w-[45%] shrink-0 text-right">
                <p className="font-mono text-sm font-semibold text-ink">Qty {row.totalQuantity}</p>
                {(row.checkedOutQuantity ?? 0) > 0 && (
                  <p className="font-mono text-[10px] text-warn">
                    {row.checkedOutQuantity ?? 0} checked out
                  </p>
                )}
                <p className="break-words font-mono text-[10px] text-ink-muted">
                  {formatLocations(row.locations)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
