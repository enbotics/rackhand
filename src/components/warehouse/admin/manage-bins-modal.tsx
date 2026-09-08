"use client";

import { useState } from "react";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { BIN_STATUS_PRESENTATION } from "@/lib/warehouse/dashboard-presentation";
import { parseBinCode } from "@/lib/warehouse/types";
import { Modal } from "../modal";
import { BUTTON_VARIANTS, ErrorNote, Panel, StatusChip } from "../ui";
import { CreateBinForm, EditBinForm } from "./bin-form";
import { AddBinsToBedForm, CreateBedForm } from "./bed-form";

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

/** Groups bins by bed, highest bed first — same rule warehouse-rack.tsx uses. */
function byBed(bins: BinView[]): Array<{ bed: number; bins: BinView[] }> {
  const beds = new Map<number, BinView[]>();
  for (const bin of bins) {
    const bed = parseBinCode(bin.code)?.bed;
    if (bed === undefined) continue;
    beds.set(bed, [...(beds.get(bed) ?? []), bin]);
  }
  return [...beds.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([bed, bins]) => ({ bed, bins }));
}

/** One bin row: view state, or swapped into edit/confirm-delete state inline. */
function BinRow({ bin, onChanged }: { bin: BinView; onChanged: () => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = BIN_STATUS_PRESENTATION[bin.status];

  if (mode === "edit") {
    return (
      <EditBinForm
        code={bin.code}
        initialStatus={bin.status}
        initialCapacity={bin.capacity}
        busy={busy}
        error={error}
        onCancel={() => setMode("view")}
        onSubmit={async (input) => {
          setBusy(true);
          setError(null);
          try {
            await callJson(`/api/warehouse/bins/${bin.code}`, {
              method: "PATCH",
              body: JSON.stringify(input),
            });
            setMode("view");
            onChanged();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Update failed.");
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  if (mode === "confirm-delete") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 animate-fade-in">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
          ! Delete {bin.code}?
        </p>
        {error ? (
          <ErrorNote>{error}</ErrorNote>
        ) : (
          <p className="text-xs text-ink-muted">
            This cannot be undone. Blocked automatically if the bin still holds inventory.
          </p>
        )}
        <div className="flex justify-end gap-2">
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
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await callJson(`/api/warehouse/bins/${bin.code}`, { method: "DELETE" });
                onChanged();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Delete failed.");
              } finally {
                setBusy(false);
              }
            }}
            className={BUTTON_VARIANTS.danger}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-mono text-[11px] font-semibold tracking-wider text-ink">{bin.code}</span>
        <StatusChip status={status} />
        <span className="font-mono text-[10px] text-ink-faint">
          {bin.totalQuantity}/{bin.capacity}
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          onClick={() => setMode("edit")}
          className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent-soft hover:text-accent"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setMode("confirm-delete")}
          className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** One bed group: its bins, plus a bed-level delete-everything action. */
function BedGroup({ bed, bins, onChanged }: { bed: number; bins: BinView[]; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          bed {bed} · {bins.length} bin{bins.length === 1 ? "" : "s"}
        </span>
        {confirming ? (
          <div className="flex items-center gap-2 animate-fade-in">
            <span className="text-[11px] text-warn">Delete all of bed {bed}?</span>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={busy}
              className={BUTTON_VARIANTS.secondary}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await callJson(`/api/warehouse/beds/${bed}`, { method: "DELETE" });
                  setConfirming(false);
                  onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Delete failed.");
                } finally {
                  setBusy(false);
                }
              }}
              className={BUTTON_VARIANTS.danger}
            >
              Delete bed
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
          >
            Delete bed
          </button>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-col gap-1.5">
        {bins.map((bin) => (
          <BinRow key={bin.binId} bin={bin} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

export function ManageBinsModal({
  bins,
  onClose,
  onChanged,
}: {
  bins: BinView[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [createBinError, setCreateBinError] = useState<string | null>(null);
  const [createBinBusy, setCreateBinBusy] = useState(false);
  const [createBedError, setCreateBedError] = useState<string | null>(null);
  const [createBedBusy, setCreateBedBusy] = useState(false);
  const [addToBedError, setAddToBedError] = useState<string | null>(null);
  const [addToBedBusy, setAddToBedBusy] = useState(false);

  const groups = byBed(bins);
  const existingBeds = groups.map((g) => g.bed);

  return (
    <Modal title="Manage bins" onClose={onClose} maxWidthClassName="max-w-3xl">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Panel title="New bin">
          <CreateBinForm
            busy={createBinBusy}
            error={createBinError}
            onSubmit={async (input) => {
              setCreateBinBusy(true);
              setCreateBinError(null);
              try {
                await callJson("/api/warehouse/bins", { method: "POST", body: JSON.stringify(input) });
                onChanged();
              } catch (err) {
                setCreateBinError(err instanceof Error ? err.message : "Create failed.");
              } finally {
                setCreateBinBusy(false);
              }
            }}
          />
        </Panel>

        <Panel title="New bed">
          <CreateBedForm
            busy={createBedBusy}
            error={createBedError}
            onSubmit={async (input) => {
              setCreateBedBusy(true);
              setCreateBedError(null);
              try {
                await callJson("/api/warehouse/beds", { method: "POST", body: JSON.stringify(input) });
                onChanged();
              } catch (err) {
                setCreateBedError(err instanceof Error ? err.message : "Create failed.");
              } finally {
                setCreateBedBusy(false);
              }
            }}
          />
        </Panel>

        <Panel title="Add to bed">
          <AddBinsToBedForm
            beds={existingBeds}
            busy={addToBedBusy}
            error={addToBedError}
            onSubmit={async (input) => {
              setAddToBedBusy(true);
              setAddToBedError(null);
              try {
                await callJson(`/api/warehouse/beds/${input.bed}`, {
                  method: "POST",
                  body: JSON.stringify({ slotCount: input.slotCount }),
                });
                onChanged();
              } catch (err) {
                setAddToBedError(err instanceof Error ? err.message : "Add failed.");
              } finally {
                setAddToBedBusy(false);
              }
            }}
          />
        </Panel>
      </div>

      <div className="mt-5 flex flex-col gap-4 border-t border-line-soft pt-4">
        {groups.length === 0 ? (
          <p className="text-xs text-ink-faint">No bins exist yet — create one above.</p>
        ) : (
          groups.map((group) => (
            <BedGroup key={group.bed} bed={group.bed} bins={group.bins} onChanged={onChanged} />
          ))
        )}
      </div>
    </Modal>
  );
}

