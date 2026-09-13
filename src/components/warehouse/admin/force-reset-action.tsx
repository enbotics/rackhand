"use client";

import { useState } from "react";
import { useWarehouseSession } from "../session";
import { ForceResetModal } from "./force-reset-modal";

/**
 * FORCE RESET, on the trigger page rather than the nav bar.
 *
 * It used to sit in the header beside the stock counters, which put a
 * warehouse-wide destructive action one stray click away on the page the
 * operator uses all day. It belongs here instead: /trig is the deliberate
 * "I am starting a run" screen, so recovering from a crashed one is the same
 * kind of visit, and reaching it now takes a navigation first.
 */
export function ForceResetAction() {
  const { bins, refresh } = useWarehouseSession();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em] text-danger transition-colors hover:border-danger hover:bg-danger/10"
      >
        FORCE RESET
      </button>
      {open && (
        <ForceResetModal
          bins={bins}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
}
