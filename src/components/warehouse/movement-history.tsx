"use client";

import type { MovementRowView } from "@/lib/warehouse/dashboard-types";
import { MOVEMENT_STATUS_PRESENTATION, formatClock } from "@/lib/warehouse/dashboard-presentation";
import { EmptyState, ErrorNote, Panel, StatusChip } from "./ui";

/**
 * Recent warehouse operations, from the Movement table.
 *
 * This is warehouse operation history, NOT agent observability — no tokens, no
 * latencies, no model events. It is also the honest answer to "did that
 * actually work": a FAILED row stays FAILED here even though the operator
 * approved the action, because approval authorises an attempt and never
 * guarantees an outcome.
 */
export function MovementHistory({
  movements,
  loading,
  error,
  onRetry,
}: {
  movements: MovementRowView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Panel title="Recent movements">
      {error && (
        <div className="mb-3">
          <ErrorNote onRetry={onRetry}>Unable to load movement history.</ErrorNote>
        </div>
      )}

      {movements.length === 0 ? (
        loading ? (
          <EmptyState>Loading movement history…</EmptyState>
        ) : (
          <EmptyState>
            No warehouse movements yet.
            <br />
            Approved putaways and retrievals appear here.
          </EmptyState>
        )
      ) : (
        <ul className="divide-y divide-line-soft">
          {movements.map((movement) => (
            <li key={movement.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-baseline gap-3">
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {formatClock(movement.createdAt)}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-medium text-ink-muted">
                  {movement.type}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-ink">
                  {movement.sku}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {movement.source ?? "—"} → {movement.destination ?? "—"}
                </span>
              </div>
              <StatusChip status={MOVEMENT_STATUS_PRESENTATION[movement.status]} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
