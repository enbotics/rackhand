"use client";

import { formatMM, formatPercent } from "@/lib/warehouse/dashboard-presentation";
import type { ConfirmedIdentity, PendingIdentification } from "./state";
import { BUTTON_VARIANTS, ErrorNote, Panel } from "./ui";

/**
 * Human identity resolution (Milestone 9) inside the command centre.
 *
 * The candidates shown are the ones the SERVER froze when it opened this
 * resolution. Pressing Select sends a partId back and the server checks it
 * against that frozen list — this card cannot invent an option, and a request
 * naming any other part is refused with `candidate_not_allowed`. The buttons
 * are a convenience for choosing; the authorisation happens server-side.
 *
 * Once confirmed the card says HUMAN CONFIRMED, never MATCHED. The matcher was
 * ambiguous and still is; what changed is who is accountable for the identity.
 */
export function CatalogResolutionCard({
  identification,
  confirmed,
  rejected,
  busy,
  error,
  onSelect,
  onReject,
}: {
  identification: PendingIdentification | null;
  confirmed: ConfirmedIdentity | null;
  rejected: boolean;
  busy: boolean;
  error: string | null;
  onSelect: (partId: string) => void;
  onReject: () => void;
}) {
  if (confirmed) {
    return (
      <Panel title="Identity" tone="attention">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
          ☑ Identity confirmed
        </p>
        <p className="mt-2 text-sm font-semibold">
          <span className="font-mono text-accent">{confirmed.sku}</span>
          <span className="ml-2 font-normal text-ink-muted">{confirmed.canonicalName}</span>
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          Human verified. The catalog matcher did not choose this — an operator did, and the
          putaway service will re-check that decision before anything moves.
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          Ask the agent to store this part. The move still needs a separate approval.
        </p>
      </Panel>
    );
  }

  if (rejected) {
    return (
      <Panel title="Identity">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          – None of these
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          No identity was recorded for this scan, so putaway stays blocked. Scan the part again, or
          hand it to someone who can add it to the catalog.
        </p>
      </Panel>
    );
  }

  if (!identification) return null;

  return (
    <Panel title="Identification required" tone="attention">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
        ! Human decision required
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{identification.reason}</p>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {identification.candidates.map((candidate) => (
          <li
            key={candidate.partId}
            className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-elevated p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-medium text-ink">{candidate.sku}</p>
              <p className="truncate text-[11px] text-ink-muted">{candidate.canonicalName}</p>
              <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                match {formatPercent(candidate.confidence)} ·{" "}
                {formatMM(candidate.dimensions.lengthMM)} × {formatMM(candidate.dimensions.widthMM)}{" "}
                × {formatMM(candidate.dimensions.heightMM)} mm
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(candidate.partId)}
              disabled={busy}
              className={`${BUTTON_VARIANTS.secondary} shrink-0`}
            >
              Select {candidate.sku}
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onReject}
        disabled={busy}
        className={`${BUTTON_VARIANTS.secondary} mt-3`}
      >
        None of these
      </button>
    </Panel>
  );
}
