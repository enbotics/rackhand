"use client";

import type { InventoryAuditView } from "@/lib/warehouse/dashboard-types";
import { EmptyState, Field, Panel } from "./ui";

function outcomeTone(status: string): string {
  if (status === "AUTO_RECONCILED" || status === "VERIFIED") return "text-success";
  if (status === "REVIEW_REQUIRED") return "text-warn";
  if (status === "FAILED") return "text-danger";
  return "text-accent";
}

export function InventoryAuditPanel({ audit }: { audit: InventoryAuditView | null }) {
  if (!audit) {
    return (
      <Panel title="Inventory auditor">
        <EmptyState>No physical inventory audit has been recorded yet.</EmptyState>
      </Panel>
    );
  }

  const active = audit.status === "RUNNING" || audit.status === "PENDING";
  return (
    <Panel title="Inventory auditor" tone={active ? "attention" : undefined}>
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

      <div className="mt-3 max-h-52 space-y-2 overflow-y-auto pr-1">
        {audit.bins.length === 0 && (
          <p className="py-3 text-center text-[11px] text-ink-faint">
            Validating the first bin…
          </p>
        )}
        {audit.bins.map((bin) => (
          <div key={bin.binAuditId} className="rounded-lg border border-line bg-bg-elevated px-3 py-2">
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
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="text-[10px] text-ink-faint">
                {bin.inventoryUpdated ? "Database inventory updated" : bin.reason ?? "No database change"}
              </span>
              {bin.evidenceUrl && (
                <a
                  href={bin.evidenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[9px] uppercase text-accent hover:underline"
                >
                  Snapshot
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
