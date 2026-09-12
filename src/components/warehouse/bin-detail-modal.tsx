"use client";

import { useState } from "react";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { BIN_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Field, NumberField, StatusChip } from "./ui";

function formatGrams(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)} g`;
}

interface ApiErrorBody {
  error: { code: string; message: string; issues?: string[] };
}

async function callJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    const err = body as ApiErrorBody;
    const message = err.error?.issues?.length
      ? `${err.error.message} (${err.error.issues.join(", ")})`
      : (err.error?.message ?? "Request failed.");
    throw new Error(message);
  }
  return body as T;
}

/**
 * One content line: view state, or swapped into an inline quantity-edit form
 * or a delete confirmation — same mode-based pattern as ManageBinsModal's
 * BinRow, so every "edit or delete this database-backed thing" card in the
 * app behaves identically.
 */
function ContentRow({
  binCode,
  item,
  onChanged,
}: {
  binCode: string;
  item: BinView["contents"][number];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [quantity, setQuantity] = useState(item.quantity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoUrl = item.imageUrl ?? item.catalogImageUrl;

  /**
   * "Delete" is not a separate concept from "set quantity to 0" — that path
   * already removes the Inventory row, releases the bin back to AVAILABLE,
   * and records an ADJUSTMENT movement with the before/after for an audit
   * trail (see setInventoryQuantity in inventory-service.ts). Reusing it here
   * means this button needs no new backend code at all.
   */
  async function removeFromBin() {
    setBusy(true);
    setError(null);
    try {
      await callJson("/api/warehouse/inventory", {
        method: "POST",
        body: JSON.stringify({ action: "set", sku: item.sku, binCode, quantity: 0 }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-bg-elevated p-3">
      <div className="flex gap-3">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={item.canonicalName}
            className="h-20 w-20 shrink-0 rounded-lg border border-line object-cover"
          />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-[10px] text-ink-faint">
            No photo
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-semibold text-ink">{item.sku}</p>
          <p className="truncate text-xs text-ink-muted">{item.canonicalName}</p>

          {mode === "edit" && (
            <form
              className="mt-2 flex items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  await callJson("/api/warehouse/inventory", {
                    method: "POST",
                    body: JSON.stringify({
                      action: "set",
                      sku: item.sku,
                      binCode,
                      quantity,
                    }),
                  });
                  setMode("view");
                  onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Update failed.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="w-24">
                <NumberField id={`qty-${item.partId}`} label="Quantity" value={quantity} onChange={setQuantity} min={0} disabled={busy} />
              </div>
              <button
                type="button"
                onClick={() => {
                  setMode("view");
                  setQuantity(item.quantity);
                  setError(null);
                }}
                disabled={busy}
                className={BUTTON_VARIANTS.secondary}
              >
                Cancel
              </button>
              <button type="submit" disabled={busy} className={BUTTON_VARIANTS.primary}>
                Save
              </button>
            </form>
          )}

          {mode === "confirm-delete" && (
            <div className="mt-2 rounded-lg border border-warn/40 bg-warn-soft p-2.5 animate-fade-in">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
                ! Remove {item.sku} from {binCode}?
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                This cannot be undone. The bin returns to AVAILABLE once empty.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode("view");
                    setError(null);
                  }}
                  disabled={busy}
                  className={BUTTON_VARIANTS.secondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void removeFromBin()}
                  disabled={busy}
                  className={BUTTON_VARIANTS.danger}
                >
                  {busy ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          )}

          {mode === "view" && (
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-xs text-ink-muted">Qty: {item.quantity}</span>
              <button
                type="button"
                onClick={() => setMode("edit")}
                className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent-soft hover:text-accent"
              >
                Edit quantity
              </button>
              <button
                type="button"
                onClick={() => setMode("confirm-delete")}
                className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
              >
                Delete
              </button>
            </div>
          )}
          {error && (
            <div className="mt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function BinDetailModal({
  bin,
  onClose,
  onChanged,
}: {
  bin: BinView;
  onClose: () => void;
  onChanged: () => void;
}) {
  const status = BIN_STATUS_PRESENTATION[bin.status];

  return (
    <Modal title={`Bin ${bin.code}`} onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <StatusChip status={status} />
            <span className="font-mono text-xs text-ink-faint">
              {bin.totalQuantity}/{bin.capacity} units
            </span>
          </div>
          <div className="mt-3 border-t border-line-soft pt-2">
            <Field label="Code">{bin.code}</Field>
            <Field label="Capacity">{bin.capacity}</Field>
          </div>
        </div>

        {bin.latestSnapshot && (
          <section className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
            {/* The URL comes from the server's warehouse snapshot, not local camera state. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={bin.latestSnapshot.imageUrl}
              alt={`Latest warehouse snapshot for bin ${bin.code}`}
              className="max-h-80 w-full border-b border-line object-contain"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
                  Latest bin snapshot · {bin.latestSnapshot.source.replaceAll("_", " ")}
                </p>
                <time
                  dateTime={new Date(bin.latestSnapshot.capturedAt).toISOString()}
                  className="mt-1 block text-[11px] text-ink-muted"
                >
                  {new Date(bin.latestSnapshot.capturedAt).toLocaleString()}
                </time>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                {bin.latestSnapshot.status.replaceAll("_", " ")}
                {bin.latestSnapshot.confidencePercent == null
                  ? ""
                  : ` · ${bin.latestSnapshot.confidencePercent}%`}
              </span>
            </div>
            {bin.latestSnapshot.source === "PUTAWAY" &&
              bin.latestSnapshot.totalWeightGrams != null && (
                <div className="border-t border-line">
                  {bin.latestSnapshot.weightSource === "FALLBACK" && (
                    <p className="border-b border-warn/30 bg-warn-soft px-3 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-warn">
                      Scale unavailable · fallback total
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-5">
                    <SnapshotMetric
                      label="Quantity"
                      value={bin.latestSnapshot.measuredQuantity?.toString() ?? "—"}
                    />
                    <SnapshotMetric
                      label="Total"
                      value={formatGrams(bin.latestSnapshot.totalWeightGrams)}
                    />
                    <SnapshotMetric
                      label="Box"
                      value={bin.latestSnapshot.tareWeightGrams == null
                        ? "—"
                        : formatGrams(bin.latestSnapshot.tareWeightGrams)}
                    />
                    <SnapshotMetric
                      label="Net"
                      value={bin.latestSnapshot.netWeightGrams == null
                        ? "—"
                        : formatGrams(bin.latestSnapshot.netWeightGrams)}
                    />
                    <SnapshotMetric
                      label="Each"
                      value={bin.latestSnapshot.unitWeightGrams == null
                        ? "—"
                        : formatGrams(bin.latestSnapshot.unitWeightGrams)}
                      accent
                    />
                  </div>
                </div>
              )}
          </section>
        )}

        {bin.contents.length === 0 ? (
          <EmptyState>This bin is empty.</EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {bin.contents.map((item) => (
              <ContentRow key={item.partId} binCode={bin.code} item={item} onChanged={onChanged} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SnapshotMetric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-bg-elevated px-3 py-2.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </p>
      <p className={`mt-1 font-mono text-xs font-semibold ${accent ? "text-accent" : "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}
