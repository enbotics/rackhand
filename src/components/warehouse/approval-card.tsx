"use client";

import type { MovementRowView } from "@/lib/warehouse/dashboard-types";
import { MOVEMENT_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import type { ApprovalOutcome, PendingApprovalView } from "./state";
import { BUTTON_VARIANTS, Field, Panel, StatusChip } from "./ui";

/**
 * The Milestone 9 approval gate, in the operator's line of sight.
 *
 * TWO THINGS THIS CARD DOES NOT DO:
 *
 *  1. It does not authorise anything. Approve sends an approval id and a
 *     decision to the server; the server holds the frozen tool arguments and
 *     re-validates every M7/M8 rule before anything moves. Nothing on this
 *     card can change what was approved — there is no editable field, by
 *     design, because an approval for B03 must never become an approval for
 *     A02 on its way back.
 *  2. It does not declare success. Pressing Approve shows "Executing…", and
 *     what replaces it comes from the resumed server run and the Movement
 *     table. An approved action can still fail on the machine, and this card
 *     has to be able to say so.
 *
 * The state summary shown is a snapshot from when the agent paused. It is
 * informational: the server does not trust it either, and re-reads bins and
 * stock at execution time.
 */
export function ApprovalCard({
  approval,
  outcome,
  busy,
  latestMovement,
  onDecide,
}: {
  approval: PendingApprovalView | null;
  outcome: ApprovalOutcome | null;
  busy: boolean;
  /** The newest Movement row, re-read from the database after a decision. */
  latestMovement: MovementRowView | null;
  onDecide: (decision: "APPROVE" | "DENY") => void;
}) {
  if (approval) {
    const { summary } = approval;
    return (
      <Panel title="Approval required" tone="attention">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
          ! Waiting for a human decision
        </p>

        <p className="mt-2 font-mono text-sm font-semibold tracking-wide text-ink">
          {summary.action}
        </p>
        <p className="mt-1 text-sm">
          <span className="font-mono text-accent">{summary.sku ?? "part not yet identified"}</span>
          {summary.canonicalName && (
            <span className="ml-2 text-ink-muted">{summary.canonicalName}</span>
          )}
        </p>

        <div className="mt-3 border-t border-line-soft pt-2">
          <Field label="Route">
            {summary.source ?? "?"} → {summary.destination ?? "?"}
          </Field>
          <Field label="Quantity">{summary.quantity}</Field>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Nothing has moved yet. No bin is reserved and no stock has changed. Approving authorises
          the attempt; the warehouse service still validates it before executing.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onDecide("DENY")}
            disabled={busy}
            className={BUTTON_VARIANTS.danger}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecide("APPROVE")}
            disabled={busy}
            className={BUTTON_VARIANTS.approve}
          >
            Approve
          </button>
        </div>
      </Panel>
    );
  }

  if (!outcome) return null;

  return (
    <Panel title="Approval">
      {outcome.kind === "EXECUTING" && (
        <div className="flex items-center gap-3">
          <div className="animate-spin-slow h-4 w-4 shrink-0 rounded-full border-2 border-line border-t-accent" />
          <p className="text-xs text-ink-muted">
            Executing… the warehouse service is validating and driving the gantry.
          </p>
        </div>
      )}

      {outcome.kind === "CANCELLED" && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          – Cancelled by operator
        </p>
      )}

      {outcome.kind === "EXPIRED" && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
          ! Approval expired
        </p>
      )}

      {outcome.kind === "REJECTED" && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
          ! Approval no longer valid
        </p>
      )}

      {outcome.kind !== "EXECUTING" && (
        <p className="mt-2 text-xs leading-relaxed text-ink">{outcome.message}</p>
      )}

      {/*
       * The authoritative outcome. Not derived from the button that was
       * pressed: this row is re-read from the Movement table after the server
       * finished, so an approved action that failed on the machine reads
       * FAILED here.
       */}
      {outcome.kind === "SETTLED" && latestMovement && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">
            {latestMovement.type} {latestMovement.sku} {latestMovement.source ?? "—"} →{" "}
            {latestMovement.destination ?? "—"}
          </span>
          <StatusChip status={MOVEMENT_STATUS_PRESENTATION[latestMovement.status]} />
        </div>
      )}
    </Panel>
  );
}
