"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { CloseIcon } from "@/components/icons";

/**
 * The one overlay primitive. Modelled directly on lightbox.tsx's existing
 * backdrop/panel pattern (same classes, same click-outside-to-close, same
 * Escape handling) rather than inventing a second visual language for
 * "floating content" — this is the first component under components/warehouse
 * to use it, since every other "needs a decision" card there (ApprovalCard,
 * CatalogResolutionCard) is inline in the page flow, not an overlay.
 */
export function Modal({
  title,
  onClose,
  children,
  maxWidthClassName = "max-w-lg",
  dismissible = true,
  closing = false,
  onExitComplete,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Callers with more content (the bin/bed admin panel) can widen the shell. */
  maxWidthClassName?: string;
  /** False while a physical workflow is active and losing the dialog would hide its state. */
  dismissible?: boolean;
  /** Capture popups leave the scene visible before processing starts. */
  closing?: boolean;
  /** Called by the overlay's real exit animation, never by an estimated delay. */
  onExitComplete?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dismissible && e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm sm:p-8 ${closing ? "capture-popup-exit pointer-events-none" : "animate-fade-in"}`}
      onClick={() => {
        if (dismissible) onClose();
      }}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onExitComplete?.();
      }}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={`glass ${closing ? "capture-popup-panel-exit" : "animate-pop"} relative flex max-h-[90vh] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-3xl border border-line shadow-[0_40px_80px_-20px_rgba(0,0,0,0.7)]`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-3">
          <h2 id="modal-title" className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">
            {title}
          </h2>
          {dismissible && (
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Close"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
