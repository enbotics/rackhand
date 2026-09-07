"use client";

import { useState } from "react";
import { SLOTS_PER_BED } from "@/lib/warehouse/types";
import { BUTTON_VARIANTS, ErrorNote, NumberField } from "../ui";

/** Creates a brand-new bed: slots 01..slotCount, all AVAILABLE. */
export function CreateBedForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (input: { bed: number; slotCount: number }) => void;
}) {
  const [bed, setBed] = useState(1);
  const [slotCount, setSlotCount] = useState(SLOTS_PER_BED);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ bed, slotCount });
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <NumberField id="new-bed-number" label="Bed number" value={bed} onChange={setBed} />
        <NumberField id="new-bed-slots" label="Slot count" value={slotCount} onChange={setSlotCount} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="submit" disabled={busy} className={BUTTON_VARIANTS.primary}>
        Create bed
      </button>
    </form>
  );
}

/** Appends more bins to a bed that already exists, starting after its current highest slot. */
export function AddBinsToBedForm({
  beds,
  busy,
  error,
  onSubmit,
}: {
  /** Existing bed numbers to choose from — beds without any bins can't be targeted here. */
  beds: number[];
  busy: boolean;
  error: string | null;
  onSubmit: (input: { bed: number; slotCount: number }) => void;
}) {
  const [bed, setBed] = useState(beds[0] ?? 1);
  const [slotCount, setSlotCount] = useState(1);

  if (beds.length === 0) {
    return <p className="text-xs text-ink-faint">No existing beds to add to yet — create one first.</p>;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ bed, slotCount });
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-to-bed-select" className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            Bed
          </label>
          <select
            id="add-to-bed-select"
            value={bed}
            onChange={(e) => setBed(Number(e.target.value))}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-line bg-bg-elevated px-3 py-2 font-mono text-xs text-ink outline-none transition-colors focus:border-accent-soft disabled:opacity-40"
          >
            {beds.map((b) => (
              <option key={b} value={b}>
                bed {b}
              </option>
            ))}
          </select>
        </div>
        <NumberField id="add-to-bed-count" label="Slots to add" value={slotCount} onChange={setSlotCount} disabled={busy} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="submit" disabled={busy} className={BUTTON_VARIANTS.primary}>
        Add bins
      </button>
    </form>
  );
}
