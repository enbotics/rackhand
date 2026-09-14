"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GantryMode } from "@/lib/gantry/types";
import { SIMULATION_ELIGIBLE_BINS, SIMULATION_LOCK_REASON } from "@/lib/warehouse/simulation-policy";

/** Opens the floating simulation dialog after mount, outside the rack's overflow clipping. */
export function AuditCaptureModeToggle({ mode = "SIMULATION", locked = true }: { mode?: GantryMode | null; locked?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();

  const showGuide = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      top: rect.bottom + 12,
      left: Math.max(12, Math.min(rect.right - 340, window.innerWidth - 352)),
      maxHeight: Math.max(0, window.innerHeight - rect.bottom - 24),
    });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (mode !== "SIMULATION" || !locked) return;
    // Wait for browser layout before positioning the default-open dialog.
    const frame = window.requestAnimationFrame(showGuide);
    return () => window.cancelAnimationFrame(frame);
  }, [showGuide, mode, locked]);

  function closeGuide() {
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open || mode !== "SIMULATION" || !locked) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function reposition() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 12,
        left: Math.max(12, Math.min(rect.right - 340, window.innerWidth - 352)),
        maxHeight: Math.max(0, window.innerHeight - rect.bottom - 24),
      });
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, mode, locked]);

  if (mode === null) return null;
  if (mode === "PRODUCTION" || !locked) {
    return <span title={mode === "PRODUCTION" ? "Production mode sends commands to real Klipper hardware." : "Gantry movement is simulated."} className="rounded-full border border-warn/40 bg-warn-soft px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-warn">{mode === "PRODUCTION" ? "Production · Klipper" : "Gantry Simulation"}</span>;
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Simulation locked — view demo guide"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={() => open ? setOpen(false) : showGuide()}
        title="Simulation is locked. Click for demo instructions."
        className="flex cursor-pointer items-center gap-2 rounded-full border border-warn/40 bg-warn-soft px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-warn transition-colors hover:border-warn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="7" width="10" height="7" rx="2" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1" />
        </svg>
        Simulation
        <span className="border-l border-warn/30 pl-2 text-[8px]">Locked</span>
        <span aria-hidden="true" className="grid size-3.5 place-items-center rounded-full border border-warn/50 text-[9px] normal-case">i</span>
      </button>
      {open && createPortal(
        <div
          ref={popup}
          id={popupId}
          role="dialog"
          aria-modal="false"
          aria-label="Simulation demo guide"
          style={position}
          className="fixed z-50 w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-warn/40 bg-bg-elevated p-4 text-sm text-ink shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-warn">Simulation is locked</h2>
            <button type="button" aria-label="Close simulation guide" onClick={closeGuide} className="grid size-6 cursor-pointer place-items-center rounded text-ink-muted hover:bg-surface hover:text-ink">×</button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">{SIMULATION_LOCK_REASON}</p>
          <div className="mt-3 flex gap-2">
            {SIMULATION_ELIGIBLE_BINS.map((bin) => <span key={bin} className="rounded-md border border-accent/30 bg-accent-soft px-2 py-1 font-mono text-[11px] text-accent">{bin}</span>)}
          </div>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-ink-faint">Try asking RackHand</p>
          <div className="mt-2 space-y-2">
            {["Bring me bin B1-01", "Bring me bin B1-02", "Return bin B1-01 to its shelf"].map((prompt) => (
              <p key={prompt} className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink">“{prompt}”</p>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">Approve the requested move in the chat. Return the checked-out bin before requesting another. Images are simulated; B1-02 uses a labeled illustration. Demo parts without a configured item weight keep their recorded quantity.</p>
          <div className="mt-4 flex justify-end border-t border-line pt-3">
            <button type="button" onClick={closeGuide} className="cursor-pointer rounded-lg border border-warn/40 bg-warn-soft px-4 py-2 text-xs font-medium text-warn transition-colors hover:border-warn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn">Got it</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
