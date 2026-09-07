"use client";

import { useState } from "react";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { BIN_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Field, NumberField, StatusChip } from "./ui";

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

/** One content line: view state, or swapped into an inline quantity-edit form. */
function ContentRow({
  binCode,
  item,
  onChanged,
}: {
  binCode: string;
  item: BinView["contents"][number];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(item.quantity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-xl border border-line bg-bg-elevated p-3">
      <div className="flex gap-3">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
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

          {editing ? (
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
                  setEditing(false);
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
                  setEditing(false);
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
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-xs text-ink-muted">Qty: {item.quantity}</span>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent-soft hover:text-accent"
              >
                Edit quantity
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
