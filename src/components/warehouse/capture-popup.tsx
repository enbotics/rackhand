"use client";

import { useEffect, useRef, useState } from "react";
import type { Shot } from "@/lib/shots-db";
import { CameraStage } from "@/components/camera-stage";
import { Modal } from "./modal";
import { ErrorNote } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Freeze one frame, dismiss smoothly, then hand that same frame to analysis. */
export function CapturePopup({ title, onCapture, onClose, disabled = false, error, captureLabel = "Capture & identify", dismissible = true }: {
  title: string;
  onCapture: (shot: Shot) => void;
  onClose: () => void;
  disabled?: boolean;
  error?: string | null;
  captureLabel?: string;
  dismissible?: boolean;
}) {
  const [exit, setExit] = useState<{ shot: Shot | null } | null>(null);
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
    if (completed.shot) callbacks.current.onCapture(completed.shot);
    else callbacks.current.onClose();
  }

  function finish(shot: Shot | null) {
    if (exitStarted.current) return;
    exitStarted.current = true;
    setExit({ shot });
  }

  return <Modal title={title} onClose={() => finish(null)} closing={exit !== null} onExitComplete={completeExit}
    dismissible={dismissible && exit === null} maxWidthClassName="max-w-2xl">
    <p className="mb-4 text-sm text-ink-muted">Position the item in the frame. After capture, watch the warehouse scan it; the result will open automatically.</p>
    <CameraStage onCapture={(shot) => finish(shot)} disabled={disabled || exit !== null} captureLabel={captureLabel} />
    {disabled && <p className="mt-3 text-xs text-ink-muted">Capture unlocks when the gantry stops.</p>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Modal>;
}
