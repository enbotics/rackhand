"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, ErrorNote } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Dismiss smoothly, then run the workflow's selected capture source. */
export function CapturePopup({ title, onCapture, onClose, disabled = false, error, captureLabel = "Capture & identify", dismissible = true, captureMode = "PROD" }: {
  title: string;
  onCapture: () => void;
  onClose: () => void;
  disabled?: boolean;
  error?: string | null;
  captureLabel?: string;
  dismissible?: boolean;
  captureMode?: "PROD" | "SIMULATION";
}) {
  const simulation = captureMode === "SIMULATION";
  const [exit, setExit] = useState<{ capture: boolean } | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const exitStarted = useRef(false);
  const reduced = usePrefersReducedMotion();
  const callbacks = useRef({ onCapture, onClose });
  callbacks.current = { onCapture, onClose };
  useEffect(() => {
    if (!exit || !reduced) return;
    const frame = requestAnimationFrame(() => completeExit());
    return () => cancelAnimationFrame(frame);
  }, [exit, reduced]);
  useEffect(() => {
    if (!previewFailed) return;
    const timer = window.setTimeout(() => {
      setPreviewFailed(false);
      setPreviewAttempt((attempt) => attempt + 1);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [previewFailed]);

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
    <div className="overflow-hidden rounded-2xl border border-line bg-bg-elevated">
      <div className="relative aspect-video bg-[#061018]">
        {simulation ? (
          <div className="absolute inset-0 grid place-items-center px-10 text-center">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">Curated simulation</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                The next curated fixture will be analyzed through the same Gemini verification used in production.
              </p>
            </div>
          </div>
        ) : !previewFailed && (
          <img
            key={previewAttempt}
            src="/api/camera/live"
            alt="Live Raspberry Pi camera preview"
            className={`h-full w-full object-cover transition-opacity duration-500 ${previewReady ? "opacity-100" : "opacity-0"}`}
            onLoad={() => setPreviewReady(true)}
            onError={() => { setPreviewReady(false); setPreviewFailed(true); }}
          />
        )}
        {!simulation && !previewReady && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center text-xs leading-relaxed text-ink-muted">
            Connecting to the live Pi camera… Capture unlocks with the first frame.
          </div>
        )}
        <div className={`absolute left-3 top-3 flex items-center gap-2 rounded-full border bg-black/65 px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] backdrop-blur ${simulation ? "border-amber-300/30 text-amber-200" : "border-success/30 text-success"}`}>
          <span className="relative flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${simulation ? "bg-amber-300" : "bg-success"}`} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${simulation ? "bg-amber-300" : "bg-success"}`} />
          </span>
          {simulation ? "SIMULATION · B1-01" : "LIVE · PI NOIR"}
        </div>
        <div className="pointer-events-none absolute inset-5 rounded-xl border border-white/15" />
        <span className="pointer-events-none absolute bottom-3 right-3 font-mono text-[9px] tracking-[0.16em] text-white/60">
          {simulation ? "CONTROLLED FIXTURE" : "1280 × 720 PREVIEW"}
        </span>
      </div>
      <div className="p-5">
        <p className="text-sm font-semibold text-ink">{simulation ? "Simulation ready" : "Frame ready for verification"}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          {simulation
            ? "This runs the next fixture in a stable sequence. No physical camera or upload is used."
            : "Capture saves one full-resolution still from this live view. The preview closes during analysis and the comparison reopens automatically."}
        </p>
        <button type="button" onClick={() => finish(true)} disabled={disabled || (!simulation && !previewReady) || exit !== null}
          className={`${BUTTON_VARIANTS.approve} mt-5 w-full`}>
          {captureLabel}
        </button>
      </div>
    </div>
    {disabled && <p className="mt-3 text-xs text-ink-muted">Capture unlocks when the gantry stops.</p>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Modal>;
}
