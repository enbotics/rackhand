"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, ErrorNote } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Dismiss smoothly, then ask the Raspberry Pi worker for one fresh frame. */
export function CapturePopup({ title, onCapture, onClose, disabled = false, error, captureLabel = "Capture & identify", dismissible = true }: {
  title: string;
  onCapture: () => void;
  onClose: () => void;
  disabled?: boolean;
  error?: string | null;
  captureLabel?: string;
  dismissible?: boolean;
}) {
  const [exit, setExit] = useState<{ capture: boolean } | null>(null);
  const exitStarted = useRef(false);
  const reduced = usePrefersReducedMotion();
  const callbacks = useRef({ onCapture, onClose });
  callbacks.current = { onCapture, onClose };
  useEffect(() => {
    if (!exit || !reduced) return;
    const frame = requestAnimationFrame(() => completeExit());
    return () => cancelAnimationFrame(frame);
  }, [exit, reduced]);

  function completeExit() {
    if (!exit) return;
    const completed = exit;
    setExit(null);
    if (completed.capture) callbacks.current.onCapture();
    else callbacks.current.onClose();
  }

  function finish(capture: boolean) {
    if (exitStarted.current) return;
    exitStarted.current = true;
    setExit({ capture });
  }

  return <Modal title={title} onClose={() => finish(false)} closing={exit !== null} onExitComplete={completeExit}
    dismissible={dismissible && exit === null} maxWidthClassName="max-w-lg">
    <div className="rounded-xl border border-line bg-bg-elevated p-5">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-40" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-success" />
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">Raspberry Pi camera capture</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Requesting a capture will close this dialog and queue one fresh image on the Pi. The analyzed result will reopen automatically.
          </p>
        </div>
      </div>
      <button type="button" onClick={() => finish(true)} disabled={disabled || exit !== null}
        className={`${BUTTON_VARIANTS.approve} mt-5 w-full`}>
        {captureLabel}
      </button>
    </div>
    {disabled && <p className="mt-3 text-xs text-ink-muted">Capture unlocks when the gantry stops.</p>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Modal>;
}
