"use client";

import { useState } from "react";
import type { BinAuditView, InventoryAuditView } from "@/lib/warehouse/dashboard-types";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Field, Panel } from "./ui";

function outcomeTone(status: string): string {
  if (status === "AUTO_RECONCILED" || status === "VERIFIED" || status === "CONFIRMED") return "text-success";
  if (status === "REVIEW_REQUIRED") return "text-warn";
  if (status === "FAILED") return "text-danger";
  return "text-accent";
}

async function postConfirmation(binAuditId: string, decision: "APPLY" | "DISMISS") {
  const response = await fetch(`/api/warehouse/audits/${binAuditId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(data.error?.message ?? "The confirmation could not be submitted.");
  }
}

function AuditBinRow({ bin, onChanged }: { bin: BinAuditView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPLY" | "DISMISS") {
    setBusy(true);
    setError(null);
    try {
      await postConfirmation(bin.binAuditId, decision);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The confirmation could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2">
      <div className="flex gap-3">
        {bin.evidenceUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bin.evidenceUrl}
            alt={`${bin.binCode} camera capture`}
            className="h-16 w-16 shrink-0 rounded-[4px] border border-line object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-ink">{bin.binCode}</span>
            <span className={`font-mono text-[9px] uppercase ${outcomeTone(bin.status)}`}>
              {bin.status.replaceAll("_", " ")}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">
            {bin.sku ?? "Expected empty"}: {bin.expectedQuantity} → {bin.observedQuantity ?? "—"}
          </p>
          <p className="mt-1 text-[10px] text-ink-faint">
            {bin.confidencePercent === null ? "No confidence score" : `${bin.confidencePercent}% confidence`}
            {" · "}
            {bin.inventoryUpdated ? "Database inventory updated" : bin.reason ?? "No database change"}
          </p>
        </div>
      </div>

      {bin.awaitingConfirmation && (
        <div className="mt-2 border-t border-line-soft pt-2">
          <p className="text-[11px] leading-relaxed text-ink-muted">
            The camera count is shown above — review it, then apply it or leave the record as it is.
            Nothing is ever written to inventory automatically.
          </p>
          {error && (
            <div className="mt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void decide("DISMISS")}
              disabled={busy}
              className={BUTTON_VARIANTS.secondary}
            >
              Leave as-is
            </button>
            <button
              type="button"
              onClick={() => void decide("APPLY")}
              disabled={busy}
              className={BUTTON_VARIANTS.approve}
            >
              {busy ? "Applying…" : `Apply ${bin.observedQuantity}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function InventoryAuditPanel({
  audit,
  onChanged,
}: {
  audit: InventoryAuditView | null;
  /** Re-reads the warehouse snapshot after a confirm/dismiss decision. */
  onChanged: () => void;
}) {
  if (!audit) {
    return (
      <Panel title="Inventory auditor">
        <EmptyState>No physical inventory audit has been recorded yet.</EmptyState>
      </Panel>
    );
  }

  const active = audit.status === "RUNNING" || audit.status === "PENDING";
  const pendingConfirmation = audit.bins.some((bin) => bin.awaitingConfirmation);
  return (
    <Panel title="Inventory auditor" tone={active || pendingConfirmation ? "attention" : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            Latest database audit
          </p>
          <p className={`mt-1 font-mono text-xs ${active ? "text-accent" : "text-ink"}`}>
            {audit.status.replaceAll("_", " ")}
          </p>
        </div>
        <span className="font-mono text-[10px] text-ink-faint">
          {audit.binsCompleted}/{audit.binsPlanned} bins
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-y border-line-soft py-3">
        <Field label="Verified">{audit.verifiedBins}</Field>
        <Field label="Updated">{audit.reconciledBins}</Field>
        <Field label="Review">{audit.reviewRequiredBins + audit.failedBins}</Field>
      </div>

      <div className="mt-3 max-h-[26rem] space-y-2 overflow-y-auto pr-1">
        {audit.bins.length === 0 && (
          <p className="py-3 text-center text-[11px] text-ink-faint">
            Validating the first bin…
          </p>
        )}
        {audit.bins.map((bin) => (
          <AuditBinRow key={bin.binAuditId} bin={bin} onChanged={onChanged} />
        ))}
      </div>
    </Panel>
  );
}
