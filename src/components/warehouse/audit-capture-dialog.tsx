"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSharedCamera } from "@/lib/camera-context";
import type { Shot } from "@/lib/shots-db";
import { CapturePopup } from "./capture-popup";
import { Modal } from "./modal";
import { BUTTON_VARIANTS } from "./ui";
import { useWarehouseSession } from "./session";

interface PendingCapture { captureId: string; binCode: string }
interface CaptureState {
  pending: PendingCapture | null;
  submitting: boolean;
  result: "success" | "failure" | null;
  error: string | null;
  capture: (shot?: Shot) => Promise<void>;
  close: () => void;
}
const CaptureContext = createContext<CaptureState | null>(null);
export function useAuditCapture() {
  const value = useContext(CaptureContext);
  if (!value) throw new Error("AuditCaptureProvider is missing");
  return value;
}

/** Single request owner above navigation. The scene and fallback UI share it. */
export function AuditCaptureProvider({ children }: { children: ReactNode }) {
  const camera = useSharedCamera();
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CaptureState["result"]>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const handledId = useRef<string | null>(null);
  const autoStartedFor = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        if (!inFlight.current) {
          const response = await fetch("/api/warehouse/audits/captures/pending", {
            cache: "no-store", signal: controller.signal,
          });
          if (response.ok) {
            const data = await response.json() as { captureId: string | null; binCode?: string };
            if (!stopped && !inFlight.current) {
              if (data.captureId && data.captureId !== handledId.current) {
                setPending((previous) => previous?.captureId === data.captureId ? previous
                  : { captureId: data.captureId!, binCode: data.binCode ?? "bin" });
                // Multi-bin runs must not wait for dismissal of the previous result.
                setResult(null);
              } else if (!data.captureId && result === null) setPending(null);
            }
          }
        }
      } catch { /* Transient poll failures do not cancel a pending capture. */ }
      if (!stopped) timer = setTimeout(poll, 1_000);
    }
    timer = setTimeout(poll, 0);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [result]);

  useEffect(() => {
    if (!pending || camera.status !== "idle" || autoStartedFor.current === pending.captureId) return;
    autoStartedFor.current = pending.captureId;
    void camera.start();
  }, [camera, pending]);

  async function capture(providedShot?: Shot) {
    if (!pending || inFlight.current || result !== null) return;
    const shot = providedShot ?? camera.captureFrame();
    if (!shot) { setError("Start the camera, then capture again."); return; }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/warehouse/audits/captures/${pending.captureId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl: shot.dataUrl, imageWidth: shot.width, imageHeight: shot.height }),
      });
      handledId.current = pending.captureId;
      setResult(response.ok ? "success" : "failure");
    } catch {
      handledId.current = pending.captureId;
      setResult("failure");
    } finally { inFlight.current = false; setSubmitting(false); }
  }

  function close() {
    if (inFlight.current) return;
    setResult(null); setPending(null); setError(null);
  }

  return <CaptureContext.Provider value={{ pending, submitting, result, error, capture, close }}>
    {children}
    <AuditCaptureDialog />
  </CaptureContext.Provider>;
}

/** Preview -> dismiss -> warehouse scanning animation -> result popup. */
export function AuditCaptureDialog() {
  const audit = useAuditCapture();
  const session = useWarehouseSession();
  if (!audit.pending) return null;
  if (audit.result !== null) return (
    <Modal title={`Capture · ${audit.pending.binCode}`} onClose={audit.close} maxWidthClassName="max-w-lg">
      <div className="space-y-4">
        <p className={audit.result === "success" ? "text-success" : "text-danger"}>
          {audit.result === "success" ? "Frame analyzed" : "Capture could not be confirmed"}
        </p>
        <p className="text-sm text-ink-muted">Follow the bin’s return and final inventory result in the Warehouse Agent conversation.</p>
        <button type="button" onClick={audit.close} className={BUTTON_VARIANTS.secondary}>Back to warehouse</button>
      </div>
    </Modal>
  );
  if (audit.submitting) return null;
  return (
    <CapturePopup key={audit.pending.captureId} title={`Audit capture · ${audit.pending.binCode}`}
      onClose={audit.close} dismissible={false} disabled={!!session.gantry?.activeOperationId}
      onCapture={(shot) => void audit.capture(shot)} captureLabel="Capture bin for audit" error={audit.error} />
  );
}
