"use client";

import type { MovementRowView } from "@/lib/warehouse/dashboard-types";
import type { GantryStatus } from "@/lib/gantry/types";
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
 *     design, because an approval for B2-01 must never become an approval for
 *     B1-02 on its way back.
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
  gantry,
  onDecide,
}: {
  approval: PendingApprovalView | null;
  outcome: ApprovalOutcome | null;
  busy: boolean;
  /** The newest Movement row, re-read from the database after a decision. */
  latestMovement: MovementRowView | null;
  gantry?: GantryStatus | null;
  onDecide: (decision: "APPROVE" | "DENY") => void;
}) {
  if (approval) {
    const { summary } = approval;

    // The model's own follow-up offer to put a just-retrieved bin back reads
    // as a plain yes/no question, not the full technical card — Approve/Deny
    // underneath are identical to the card below; only the presentation
    // differs, since nothing here needed a scope/capacity/route preview the
    // operator hasn't already just seen play out for the retrieval itself.
    if (summary.autoSuggested) {
      return (
        <Panel title="Put it back?" tone="attention">
          <p className="text-sm text-ink">
            Bin <span className="font-mono text-accent">{summary.destination ?? "?"}</span> was
            just retrieved. Put it back now?
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => onDecide("DENY")}
              disabled={busy}
              className={BUTTON_VARIANTS.secondary}
            >
              Not now
            </button>
            <button
              type="button"
              onClick={() => onDecide("APPROVE")}
              disabled={busy}
              className={BUTTON_VARIANTS.approve}
            >
              Put it back
            </button>
          </div>
        </Panel>
      );
    }

    if (summary.action === "MATERIALS_FULFILLMENT") {
      const materialTypeCount = summary.quantity ?? 0;
      return (
        <Panel title="Ready to start" tone="attention">
          <div className="space-y-4">
            <div>
              <p className="font-mono text-3xl font-semibold tabular-nums text-ink">
                {materialTypeCount}
              </p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
                material type{materialTypeCount === 1 ? "" : "s"}
              </p>
            </div>
            <p className="text-sm leading-6 text-ink-muted">
              RackHand will bring each selected container to OUTPUT one at a time.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => onDecide("DENY")}
                disabled={busy}
                className={BUTTON_VARIANTS.secondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onDecide("APPROVE")}
                disabled={busy}
                className={BUTTON_VARIANTS.approve}
              >
                {busy ? "Starting…" : "Start job"}
              </button>
            </div>
          </div>
        </Panel>
      );
    }

    return (
      <Panel title="Approval required" tone="attention">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
          ! Waiting for a human decision
        </p>

        <p className="mt-2 font-mono text-sm font-semibold tracking-wide text-ink">
          {summary.action}
        </p>
        {summary.action === "INVENTORY_AUDIT" ? (
          <p className="mt-1 text-sm text-ink-muted">
            One camera frame per bin; confidence must be strictly above 80% for an automatic
            inventory update.
          </p>
        ) : (
          <p className="mt-1 text-sm">
            <span className="font-mono text-accent">{summary.sku ?? "part not yet identified"}</span>
            {summary.canonicalName && (
              <span className="ml-2 text-ink-muted">{summary.canonicalName}</span>
            )}
          </p>
        )}

        <div className="mt-3 border-t border-line-soft pt-2">
          <Field label="Movement">
            {summary.source ?? "?"} → {summary.destination ?? "?"}
          </Field>
          <Field label="Amount">
            {summary.scope === "AUDIT_BINS"
              ? summary.source === "all auditable shelf bins"
                ? "All auditable shelf bins, sequentially"
                : `One physical bin (${summary.source})`
              : summary.scope === "MATERIALS_PLAN"
                ? `${summary.quantity ?? "Planned"} material requirement${summary.quantity === 1 ? "" : "s"}`
              : summary.scope === "ENTIRE_BIN"
              ? "Entire physical bin"
              : `${summary.quantity ?? "Camera count pending"} counted unit${summary.quantity === 1 ? "" : "s"}`}
          </Field>
          {summary.scope === "ENTIRE_BIN" && summary.quantity !== null && (
            <Field label="Recorded contents">
              {summary.quantity} unit{summary.quantity === 1 ? "" : "s"} (last verified)
            </Field>
          )}
          {summary.capacity && (
            <Field label="Capacity">
              {summary.capacity.before} → {summary.capacity.after}/{summary.capacity.limit}
            </Field>
          )}
        </div>

        {summary.action === "PUTAWAY" && <p className="mt-3 rounded-lg border border-accent-soft/40 bg-accent-tint p-3 text-xs text-ink-muted">
          After approval, frame the whole bin and manually verify it. The comparison shows both snapshots,
          quantity and confidence; decreases need confirmation while safe increases update automatically.
        </p>}

        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Nothing has moved yet. No bin is reserved and no stock has changed. Approving authorises
          the attempt. Counts at or below 80% confidence remain unchanged for review.
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
        <div className="animate-stage-reveal space-y-3">
          <div className="flex items-center gap-3">
            <div className="animate-spin-slow h-4 w-4 shrink-0 rounded-full border-2 border-line border-t-accent" />
            <p className="text-xs text-ink-muted">
              Starting… RackHand is checking the request. Camera verification may require your confirmation before the gantry runs.
            </p>
          </div>
          {/*
           * No animation here, deliberately. The digital warehouse panel on
           * this same page draws the arm at its real, position-accurate place
           * on the rack; a second abstract box sliding along a line beside it
           * showed the same trip less truthfully. This card states the route
           * and the controller's status in words instead.
           */}
          <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
              Movement
            </p>
            <p className="mt-1 font-mono text-[11px] text-ink-muted">
              {outcome.summary?.action === "INVENTORY_AUDIT"
                ? `${outcome.summary?.source ?? "Shelf bins"} → SCAN_STATION`
                : `${outcome.summary?.source ?? "?"} → ${outcome.summary?.destination ?? "?"}`}
            </p>
          </div>
          <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
            <span>Gantry {gantry?.state ?? "STARTING"}</span>
            <span>{gantry?.currentLocation ?? "HOME"}</span>
          </div>
          <p className="text-[11px] text-ink-faint">
            The arm&apos;s live position is shown on the rack.
          </p>
        </div>
      )}

      {outcome.kind === "DECIDING" && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          – Cancelling without moving the gantry
        </p>
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

      {outcome.kind !== "EXECUTING" && outcome.kind !== "DECIDING" && (
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
