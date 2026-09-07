"use client";

import { formatMM, formatPercent } from "@/lib/warehouse/dashboard-presentation";
import type { ConfirmedIdentity, PendingIdentification } from "./state";
import { BUTTON_VARIANTS, ErrorNote, Panel } from "./ui";

/**
 * Human identity resolution (Milestone 9) inside the command centre.
 *
 * The candidates shown are the ones the SERVER froze when it opened this
 * resolution. Pressing a candidate tile sends a partId back and the server
 * checks it against that frozen list — this card cannot invent an option, and
 * a request naming any other part is refused with `candidate_not_allowed`.
 * The tiles are a convenience for choosing; the authorisation happens
 * server-side.
 *
 * IDENTIFY BY SIGHT, NOT BY READING A SKU. A generated SKU like NEW-C9634D7E
 * means nothing to a human — it's an internal key, not a description. Each
 * candidate is shown as its own photo with a match score, because "does this
 * picture look like what's on the mat" is a question anyone can answer
 * instantly, and "which of these two mostly-numeric strings is correct" is
 * not. A part with no photo yet (older catalog data) still shows — just as a
 * plain placeholder tile — so it's never silently hidden from the choice.
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
  detectedName,
  onRegisterNewPart,
  registeringPart,
  registerError,
}: {
  identification: PendingIdentification | null;
  confirmed: ConfirmedIdentity | null;
  rejected: boolean;
  busy: boolean;
  error: string | null;
  onSelect: (partId: string) => void;
  onReject: () => void;
  /** The vision system's own label for the scanned object — used only for the rejected-state copy. */
  detectedName: string | null;
  onRegisterNewPart: () => void;
  registeringPart: boolean;
  registerError: string | null;
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
      <Panel title="Identity" tone="attention">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          – No matching catalog item
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          Nothing was selected. Choose the simple next step below to continue.
        </p>

        {/* The clear, primary way forward — not a small button buried below a
            wall of text. If nothing in the catalog looked right, the most
            likely explanation is that this genuinely is a new part. */}
        <div className="mt-4 rounded-xl border border-accent-soft/60 bg-accent-tint p-4">
          <p className="text-sm font-semibold text-ink">
            Add <span className="text-accent">{detectedName ?? "this object"}</span> as a new
            catalog item
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            Register it using this scan&apos;s own measurement and photo — it then behaves like any
            other catalog part, and this scan can continue straight into putaway.
          </p>
          {registerError && (
            <div className="mt-3">
              <ErrorNote>{registerError}</ErrorNote>
            </div>
          )}
          <button
            type="button"
            onClick={onRegisterNewPart}
            disabled={registeringPart}
            className={`${BUTTON_VARIANTS.primary} mt-3 w-full sm:w-auto`}
          >
            {registeringPart ? "Registering…" : "Register as new catalog part"}
          </button>
        </div>

        <p className="mt-3 text-xs text-ink-faint">
          Otherwise, scan the part again — a fresh photo may score differently.
        </p>
      </Panel>
    );
  }

  if (!identification) return null;

  return (
    <Panel title="Identification required" tone="attention">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
        Step 1 · Choose the matching item
      </p>
      <p className="mt-2 text-sm font-medium text-ink">
        Does one of these photos match the item you scanned?
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        Select the matching photo. If none match, use the large option directly below the photos.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{identification.reason}</p>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {identification.candidates.map((candidate) => (
          <button
            key={candidate.partId}
            type="button"
            onClick={() => onSelect(candidate.partId)}
            disabled={busy}
            aria-label={`Select ${candidate.sku} (${candidate.canonicalName})`}
            className="group flex flex-col overflow-hidden rounded-xl border border-line bg-bg-elevated text-left transition-colors hover:border-accent-soft disabled:pointer-events-none disabled:opacity-40"
          >
            <div className="relative aspect-square w-full bg-surface">
              {candidate.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={candidate.imageUrl}
                  alt={candidate.canonicalName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-faint">
                  No photo
                </div>
              )}
              <span className="absolute right-1.5 top-1.5 rounded-md border border-line bg-bg/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent backdrop-blur-sm">
                {formatPercent(candidate.confidence)}
              </span>
            </div>
            <div className="p-2">
              <p className="truncate text-[11px] font-medium text-ink group-hover:text-accent">
                {candidate.canonicalName}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                {candidate.sku} · {formatMM(candidate.dimensions.lengthMM)} ×{" "}
                {formatMM(candidate.dimensions.widthMM)} × {formatMM(candidate.dimensions.heightMM)} mm
              </p>
            </div>
          </button>
        ))}
      </div>

      <div className="my-4 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
          Or
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        type="button"
        onClick={onReject}
        disabled={busy}
        aria-label="None of these match — continue with a different item"
        className="group flex w-full items-center justify-between gap-4 rounded-xl border-2 border-warn/60 bg-warn-soft px-4 py-3.5 text-left transition-all hover:border-warn hover:bg-warn-soft/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn disabled:pointer-events-none disabled:opacity-40"
      >
        <span>
          <span className="block text-sm font-semibold text-ink">None of these match</span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
            The scanned item is different. Continue to register it as new or scan again.
          </span>
        </span>
        <span
          className="shrink-0 rounded-full border border-warn/50 bg-bg/40 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-warn transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        >
          Continue →
        </span>
      </button>
    </Panel>
  );
}
