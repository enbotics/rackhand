"use client";

import type { GantryStatus } from "@/lib/gantry/types";
import type { MovementRowView } from "@/lib/warehouse/dashboard-types";
import { GANTRY_STATE_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, ErrorNote, Field, Panel, StatusChip } from "./ui";

/**
 * The machine's own account of itself — read-only.
 *
 * There are deliberately NO controls here. Home, move, pick and drop are not
 * operator actions in this system: warehouse state changes go through the
 * putaway and retrieval services, which drive the gantry themselves and only
 * commit inventory once the machine reports success. A button that moved the
 * head independently would let the physical warehouse and the database
 * disagree, silently.
 *
 * The route line is a status readout, not a simulation. It shows which
 * movement the warehouse currently has in flight; it never animates a position
 * the controller has not reported.
 */
export function GantryStatusPanel({
  status,
  error,
  activeMovement,
}: {
  status: GantryStatus | null;
  error: string | null;
  activeMovement: MovementRowView | null;
}) {
  const state = status ? GANTRY_STATE_PRESENTATION[status.state] : null;

  return (
    <Panel
      title="Gantry"
      meta={
        <span className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn-soft px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.1em] text-warn">
          <span aria-hidden="true">◈</span>
          {status?.mode ?? "SIMULATION"}
        </span>
      }
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>Gantry status unavailable. The rest of the warehouse is unaffected.</ErrorNote>
        </div>
      )}

      {!status && !error ? (
        <EmptyState>Reading machine state…</EmptyState>
      ) : (
        <div className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-3 py-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              State
            </span>
            {state ? (
              <StatusChip status={state} />
            ) : (
              <span className="font-mono text-xs text-ink-faint">unknown</span>
            )}
          </div>

          <Field label="Location">{status?.currentLocation ?? "HOME"}</Field>
          <Field label="Homed">{status?.homed ? "yes" : "no"}</Field>

          <div className="flex items-baseline justify-between gap-3 py-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              Operation
            </span>
            <span className="min-w-0 truncate text-right font-mono text-xs text-ink">
              {activeMovement
                ? `${activeMovement.type} ${activeMovement.source ?? "—"} → ${activeMovement.destination ?? "—"}`
                : "none"}
            </span>
          </div>

          {status?.lastError && (
            <div className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-danger">
                Last error
              </p>
              <p className="mt-0.5 font-mono text-xs text-danger">{status.lastError}</p>
            </div>
          )}

          <p className="pt-3 text-[11px] leading-relaxed text-ink-faint">
            No physical gantry is connected. Movements are executed by the in-process simulator.
          </p>
        </div>
      )}
    </Panel>
  );
}
