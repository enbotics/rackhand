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

/** Short, reason-specific line — the chat message stays brief precisely because this card carries the detail. */
function reviewMessage(bin: BinAuditView): string {
  const retry = bin.captureMode === "SIMULATION"
    ? "Run the audit again to analyze the next simulated capture."
    : "Retry the audit with a fresh photo.";
  switch (bin.reason) {
    case "audit_pending_confirmation":
      return bin.captureMode === "SIMULATION"
        ? "The simulated count was confidently lower. Inventory was left unchanged; run the audit again for the next simulation."
        : "Confident, safe count — just lower than what's on file. Confirm it or leave the record as it is.";
    case "foreign_object_suspected":
      return `An unexpected object was seen alongside the part. This count can't be trusted. ${retry}`;
    case "audit_capacity_exceeded":
      return `The observed count exceeds this bin's capacity. ${retry}`;
    case "physical_stock_without_record":
      return "Stock is visible but no catalog record expects any here. Resolve this from bin management, not this card.";
    default:
      return `The image wasn't clear or confident enough to trust. ${retry}`;
  }
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

/** One before/after evidence thumbnail. Absence is shown, never silently skipped. */
function EvidenceThumb({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{label}</p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="mt-1 h-20 w-full rounded-[4px] border border-line object-cover"
        />
      ) : (
        <div className="mt-1 flex h-20 w-full items-center justify-center rounded-[4px] border border-dashed border-line text-[9px] text-ink-faint">
          None yet
        </div>
      )}
    </div>
  );
}

function AuditBinRow({ bin, onChanged }: { bin: BinAuditView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasEvidence = bin.evidenceUrl !== null || bin.priorEvidenceUrl !== null;

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
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-ink">{bin.binCode}</span>
        <span className={`font-mono text-[9px] uppercase ${outcomeTone(bin.status)}`}>
          {bin.status.replaceAll("_", " ")}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">
        {bin.sku ?? "Expected empty"}: {bin.expectedQuantity} → {bin.observedQuantity ?? "—"}
        {bin.confidencePercent === null ? "" : ` · ${bin.confidencePercent}% confidence`}
      </p>
      <p className="mt-1 text-[10px] text-ink-faint">
        {bin.inventoryUpdated ? "Database inventory updated" : bin.reason ?? "No database change"}
      </p>

      {/* Before/after, whenever either photo exists — not just while a
          decision is pending, so a settled result stays visually checkable. */}
      {hasEvidence && (
        <div className="mt-2 flex gap-2">
          <EvidenceThumb label="Before this audit" url={bin.priorEvidenceUrl} />
          <EvidenceThumb label="This capture" url={bin.evidenceUrl} />
        </div>
      )}

      {bin.awaitingConfirmation && (
        <div className="mt-2 border-t border-line-soft pt-2">
          <p className="text-[11px] leading-relaxed text-ink-muted">{reviewMessage(bin)}</p>
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
            {/* Apply only when the count itself is trustworthy (just lower
                than recorded) — every other reason means the count can't be
                trusted at all, so there is nothing safe to apply. */}
            {bin.canApply && (
              <button
                type="button"
                onClick={() => void decide("APPLY")}
                disabled={busy}
                className={BUTTON_VARIANTS.approve}
              >
                {busy ? "Applying…" : `Apply ${bin.observedQuantity}`}
              </button>
            )}
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
