"use client";

import { useState } from "react";
import { BIN_STATUSES, type BinStatus } from "@/lib/warehouse/types";
import { BUTTON_VARIANTS, ErrorNote, NumberField, SelectField, TextField } from "../ui";

/** AUDITING is an internal lock owned by the physical audit service. */
const OPERATOR_BIN_STATUSES = BIN_STATUSES.filter((status) => status !== "AUDITING");

/** Create a single bin — a bare code + starting status/capacity. */
export function CreateBinForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (input: { code: string; status: BinStatus; capacity: number }) => void;
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<BinStatus>("AVAILABLE");
  const [capacity, setCapacity] = useState(100);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ code, status, capacity });
      }}
      className="flex flex-col gap-3"
    >
      <TextField id="new-bin-code" label="Bin code" value={code} onChange={setCode} placeholder="e.g. B7-01" disabled={busy} />
      <div className="grid grid-cols-2 gap-3">
        <SelectField id="new-bin-status" label="Status" value={status} options={OPERATOR_BIN_STATUSES} onChange={setStatus} disabled={busy} />
        <NumberField id="new-bin-capacity" label="Capacity" value={capacity} onChange={setCapacity} disabled={busy} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="submit" disabled={busy || code.trim() === ""} className={BUTTON_VARIANTS.primary}>
        Create bin
      </button>
    </form>
  );
}

/** Edit an existing bin's status/capacity. Code is fixed — renaming a bin isn't supported. */
export function EditBinForm({
  code,
  initialStatus,
  initialCapacity,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  code: string;
  initialStatus: BinStatus;
  initialCapacity: number;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { status: BinStatus; capacity: number }) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<BinStatus>(initialStatus);
  const [capacity, setCapacity] = useState(initialCapacity);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ status, capacity });
      }}
      className="flex flex-col gap-3 rounded-lg border border-line bg-bg-elevated p-3 animate-fade-in"
    >
      <p className="font-mono text-[11px] font-semibold tracking-wider text-ink">Editing {code}</p>
      <div className="grid grid-cols-2 gap-3">
        <SelectField id={`edit-${code}-status`} label="Status" value={status} options={OPERATOR_BIN_STATUSES} onChange={setStatus} disabled={busy} />
        <NumberField id={`edit-${code}-capacity`} label="Capacity" value={capacity} onChange={setCapacity} disabled={busy} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BUTTON_VARIANTS.secondary}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={BUTTON_VARIANTS.primary}>
          Save
        </button>
      </div>
    </form>
  );
}
