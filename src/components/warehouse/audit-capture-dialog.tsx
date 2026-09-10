"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { waitForCameraCapture } from "@/lib/camera/capture-client";
import type { PutawayCaptureDecision, PutawayCaptureView } from "@/lib/warehouse/putaway-capture-types";
import type { AuditCaptureDecision, AuditCaptureView } from "@/lib/warehouse/audit-capture-types";
import { CapturePopup } from "./capture-popup";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, Metric } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";

interface PendingCapture { captureId: string; binCode: string; purpose: "AUDIT" | "PUTAWAY" }
type CaptureDecision = PutawayCaptureDecision | AuditCaptureDecision;
type CaptureAnalysis = PutawayCaptureView | AuditCaptureView;
interface CaptureState {
  pending: PendingCapture | null;
  submitting: boolean;
  result: "success" | "failure" | null;
  analysis: CaptureAnalysis | null;
  deciding: boolean;
  error: string | null;
  capture: () => Promise<void>;
  decide: (decision: CaptureDecision) => Promise<void>;
  close: () => void;
}
const CaptureContext = createContext<CaptureState | null>(null);
export function useAuditCapture() {
  const value = useContext(CaptureContext);
  if (!value) throw new Error("AuditCaptureProvider is missing");
  return value;
}

/** Single Pi-capture request owner above navigation. */
export function AuditCaptureProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CaptureState["result"]>(null);
  const [analysis, setAnalysis] = useState<CaptureAnalysis | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/warehouse/captures/events");
    const handlePending = (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as {
          captureId: string | null;
          binCode?: string;
          purpose?: "PUTAWAY" | "AUDIT";
          analysis?: CaptureAnalysis | null;
        };
        if (data.captureId && data.purpose) {
          // An analyzed result is authoritative even while capture() is still
          // awaiting the separate per-job stream. Ignoring this event while
          // inFlight creates a race where one missed job update hides a result
          // that has already been committed to the database.
          if (inFlight.current && !data.analysis) return;
          if (data.captureId === handledId.current && !data.analysis) return;
          setPending((previous) => previous?.captureId === data.captureId ? previous : {
            captureId: data.captureId!,
            binCode: data.binCode ?? "bin",
            purpose: data.purpose!,
          });
          if (data.analysis) {
            // Restore an analyzed-but-undecided putaway after navigation,
            // refresh, or an SSE reconnect. The durable row—not component
            // memory—owns whether the operator still needs to act.
            setAnalysis(data.analysis);
            setResult("success");
          } else {
            // Multi-bin runs must not wait for dismissal of the previous result.
            setAnalysis(null);
            setResult(null);
          }
        } else if (!data.captureId && !inFlight.current) {
          setPending(null);
        }
      } catch { /* A later authoritative Realtime event will replace malformed data. */ }
    };
    source.addEventListener("pending", handlePending);
    return () => {
      source.removeEventListener("pending", handlePending);
      source.close();
    };
  }, []);

  async function capture() {
    if (!pending || inFlight.current || result !== null) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const kind = pending.purpose === "PUTAWAY" ? "putaway" : "audits";
      const response = await fetch(`/api/warehouse/${kind}/captures/${pending.captureId}`, {
        method: "POST",
      });
      const requested = await response.json() as {
        captureJobId?: string;
        error?: { message?: string };
      };
      if (!response.ok || !requested.captureJobId) {
        throw new Error(requested.error?.message ?? "The Raspberry Pi capture could not be requested.");
      }
      const completed = await waitForCameraCapture<CaptureAnalysis>(requested.captureJobId, {
        // The durable server state owns recovery. The browser follows the
        // Realtime stream until a terminal state instead of inventing a
        // second, shorter timeout.
      });
      if (!completed.result) throw new Error("The Raspberry Pi capture completed without an analysis result.");
      handledId.current = pending.captureId;
      setAnalysis(completed.result);
      setResult("success");
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "The Raspberry Pi capture failed.");
      setResult(null);
    } finally { inFlight.current = false; setSubmitting(false); }
  }

  async function decide(decision: CaptureDecision) {
    if (!pending || deciding) return;
    setDeciding(true);
    setError(null);
    try {
      const kind = pending.purpose === "PUTAWAY" ? "putaway" : "audits";
      const response = await fetch(`/api/warehouse/${kind}/captures/${pending.captureId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The verification decision could not be applied.");
      }
      if (decision === "RETRY") {
        handledId.current = null;
        setResult(null);
        setAnalysis(null);
      } else {
        setResult(null);
        setAnalysis(null);
        setPending(null);
      }
    } catch (decisionError) {
      setError(decisionError instanceof Error
        ? decisionError.message
        : "The verification decision could not be applied.");
    } finally {
      setDeciding(false);
    }
  }

  function close() {
    if (inFlight.current) return;
    setResult(null); setAnalysis(null); setPending(null); setError(null);
  }

  return <CaptureContext.Provider value={{ pending, submitting, result, analysis, deciding, error, capture, decide, close }}>
    {children}
    <AuditCaptureDialog />
  </CaptureContext.Provider>;
}

const AUDIT_COPY: Record<AuditCaptureView["outcome"], {
  headline: string;
  tone: "success" | "warn";
  message: (view: AuditCaptureView) => string;
  primary: { label: string | ((view: AuditCaptureView) => string); decision: AuditCaptureDecision };
  secondary?: { label: string; decision: AuditCaptureDecision };
}> = {
  VERIFIED: {
    headline: "Verified",
    tone: "success",
    message: () => "Recorded quantity confirmed — nothing was changed.",
    primary: { label: "Done", decision: "ACCEPT" },
  },
  AUTO_RECONCILED: {
    headline: "Updated automatically",
    tone: "success",
    message: (view) => `Higher quantity detected. Inventory has already been updated to ${view.observedQuantity ?? "—"}.`,
    primary: { label: "Done", decision: "ACCEPT" },
  },
  REVIEW_DECREASE: {
    headline: "Confirm the lower count",
    tone: "warn",
    message: (view) => `Recorded quantity ${view.expectedQuantity}; observed quantity ${view.observedQuantity ?? "—"}.`,
    primary: { label: (view) => `Confirm ${view.observedQuantity ?? ""} and continue`, decision: "ACCEPT" },
    secondary: { label: "Retry photo", decision: "RETRY" },
  },
  FOREIGN_OBJECTS: {
    headline: "Unexpected object detected",
    tone: "warn",
    message: (view) => `Remove: ${view.foreignObjects.length ? view.foreignObjects.join(", ") : "the unexpected object"}.`,
    primary: { label: "Removed · retry photo", decision: "RETRY" },
  },
  LOW_CONFIDENCE: {
    headline: "Needs a clearer photo",
    tone: "warn",
    message: (view) => view.notes || "The count is not confident enough to act on. Improve the view and retry.",
    primary: { label: "Retry photo", decision: "RETRY" },
  },
  CAPACITY_EXCEEDED: {
    headline: "Exceeds bin capacity",
    tone: "warn",
    message: (view) => `Observed quantity ${view.observedQuantity ?? "—"} exceeds this bin's capacity. Correct the contents, then retry.`,
    primary: { label: "Retry photo", decision: "RETRY" },
  },
};

/** Preview -> dismiss -> warehouse scanning animation -> result popup. */
export function AuditCaptureDialog() {
  const audit = useAuditCapture();
  const [closing, setClosing] = useState(false);
  const pendingDecision = useRef<CaptureDecision | null>(null);
  const reduced = usePrefersReducedMotion();
  const auditRef = useRef(audit);
  auditRef.current = audit;

  useEffect(() => {
    const reset = setTimeout(() => setClosing(false), 0);
    return () => clearTimeout(reset);
  }, [audit.pending?.captureId, audit.pending?.purpose, audit.result]);

  useEffect(() => {
    if (!closing || !reduced) return;
    const frame = requestAnimationFrame(() => completeDecision());
    return () => cancelAnimationFrame(frame);
  }, [closing, reduced]);

  function beginDecision(decision: CaptureDecision) {
    if (closing || audit.deciding) return;
    pendingDecision.current = decision;
    setClosing(true);
  }

  function completeDecision() {
    const decision = pendingDecision.current;
    if (!decision) return;
    pendingDecision.current = null;
    void auditRef.current.decide(decision).finally(() => setClosing(false));
  }

  if (!audit.pending) return null;

  if (audit.result !== null && audit.pending.purpose === "PUTAWAY") {
    const result = audit.analysis as PutawayCaptureView | null;
    const canAccept = result && ["READY", "INCREASED", "REVIEW_DECREASE"].includes(result.outcome);
    const warning = result?.outcome === "FOREIGN_OBJECTS"
      ? `Remove ${result.foreignObjects.length ? result.foreignObjects.join(", ") : "the unexpected object"}, then take a fresh photo.`
      : result?.outcome === "LOW_CONFIDENCE"
        ? "The count is not confident enough to change inventory. Improve the view and retry."
        : result?.outcome === "CAPACITY_EXCEEDED"
          ? "The observed quantity exceeds this bin’s capacity. Correct the contents or choose another bin."
          : audit.result === "failure" ? "The image could not be analyzed. Take a fresh photo and retry." : null;
    return (
      <Modal title={`Putaway comparison · ${audit.pending.binCode}`} onClose={() => {}} closing={closing}
        onExitComplete={completeDecision} dismissible={false} maxWidthClassName="max-w-3xl">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ComparisonImage label="Previous snapshot" src={result?.previousImageUrl ?? null} />
            <ComparisonImage label="Current verification" src={result?.currentImageUrl ?? null} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Recorded qty" value={result?.expectedQuantity ?? "—"} />
            <Metric label="Observed qty" value={result?.observedQuantity ?? "—"}
              tone={result?.outcome === "REVIEW_DECREASE" ? "warn" : "accent"} />
            <Metric label="Confidence" value={result?.confidencePercent ?? "—"} unit={result?.confidencePercent == null ? undefined : "%"}
              tone={(result?.confidencePercent ?? 0) > 80 ? "ok" : "warn"} />
          </div>
          {warning && <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
            <p className="font-semibold">Verification needs attention</p>
            <p className="mt-1 text-xs leading-relaxed">{warning}</p>
          </div>}
          {result?.outcome === "INCREASED" && <p className="text-sm text-success">
            Higher quantity detected. Inventory will update automatically after the gantry completes putaway.
          </p>}
          {result?.outcome === "REVIEW_DECREASE" && <p className="text-sm text-warn">
            The quantity decreased. Confirm this observed count before inventory is changed.
          </p>}
          {result?.notes && <p className="text-xs text-ink-muted">{result.notes}</p>}
          {audit.error && <p className="text-xs text-danger">{audit.error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={audit.deciding || closing} onClick={() => beginDecision("RETRY")} className={BUTTON_VARIANTS.secondary}>
              {result?.outcome === "FOREIGN_OBJECTS" ? "Removed · retry photo" : "Retry photo"}
            </button>
            {canAccept && <button type="button" disabled={audit.deciding || closing} onClick={() => beginDecision("ACCEPT")} className={BUTTON_VARIANTS.approve}>
              {result?.outcome === "REVIEW_DECREASE" ? `Confirm ${result.observedQuantity} & continue` : "Continue putaway"}
            </button>}
          </div>
        </div>
      </Modal>
    );
  }

  // status !== "ACCEPTED" is what actually distinguishes "still needs a
  // decision or a dismissal" from an already fully-closed-out result — an
  // unexpected-stock capture finalizes straight to ACCEPTED server-side
  // (nothing on file to confirm or retry against), so it falls through to
  // the plain fallback screen below instead of offering a stale "Retry".
  if (audit.result !== null && audit.pending.purpose === "AUDIT" && audit.result === "success"
    && (audit.analysis as AuditCaptureView).status !== "ACCEPTED") {
    const result = audit.analysis as AuditCaptureView;
    const copy = AUDIT_COPY[result.outcome];
    return (
      <Modal title={`Audit comparison · ${audit.pending.binCode}`} onClose={() => {}} closing={closing}
        onExitComplete={completeDecision} dismissible={false} maxWidthClassName="max-w-3xl">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ComparisonImage label="Previous accepted snapshot" src={result.previousImageUrl} />
            <ComparisonImage label="Newly captured snapshot" src={result.currentImageUrl} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Recorded qty" value={result.expectedQuantity} />
            <Metric label="Observed qty" value={result.observedQuantity ?? "—"}
              tone={copy.tone === "warn" ? "warn" : "accent"} />
            <Metric label="Confidence" value={result.confidencePercent ?? "—"} unit={result.confidencePercent == null ? undefined : "%"}
              tone={(result.confidencePercent ?? 0) > 80 ? "ok" : "warn"} />
          </div>
          <div className={`rounded-xl border p-3 text-sm ${copy.tone === "warn" ? "border-warn/40 bg-warn-soft text-warn" : "border-success/40 bg-success-soft text-success"}`}>
            <p className="font-semibold">{copy.headline}</p>
            <p className="mt-1 text-xs leading-relaxed">{copy.message(result)}</p>
          </div>
          {result.notes && result.outcome !== "LOW_CONFIDENCE" && <p className="text-xs text-ink-muted">{result.notes}</p>}
          {audit.error && <p className="text-xs text-danger">{audit.error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {copy.secondary && (
              <button type="button" disabled={audit.deciding || closing} onClick={() => beginDecision(copy.secondary!.decision)} className={BUTTON_VARIANTS.secondary}>
                {copy.secondary.label}
              </button>
            )}
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision(copy.primary.decision)}
              className={copy.primary.decision === "ACCEPT" ? BUTTON_VARIANTS.approve : BUTTON_VARIANTS.secondary}
            >
              {typeof copy.primary.label === "function" ? copy.primary.label(result) : copy.primary.label}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (audit.result !== null) return (
    <Modal title={`Capture · ${audit.pending.binCode}`} onClose={audit.close} maxWidthClassName="max-w-lg">
      <div className="space-y-4">
        <p className={audit.result === "success" ? "text-success" : "text-danger"}>
          {audit.result === "success" ? "Frame analyzed" : "Capture could not be confirmed"}
        </p>
        <p className="text-sm text-ink-muted">{audit.result === "failure"
          ? "Audit capture failed. Follow the safe return and review outcome in the Warehouse Agent conversation."
          : "Photo verification finished. Follow the audit result in the Warehouse Agent conversation."}</p>
        <button type="button" onClick={audit.close} className={BUTTON_VARIANTS.secondary}>Back to warehouse</button>
      </div>
    </Modal>
  );
  if (audit.submitting) return null;
  return (
    <CapturePopup key={audit.pending.captureId} title={`${audit.pending.purpose === "PUTAWAY" ? "Putaway snapshot" : "Audit capture"} · ${audit.pending.binCode}`}
      onClose={audit.close} dismissible={false}
      onCapture={() => void audit.capture()} captureLabel={audit.pending.purpose === "PUTAWAY" ? "Verify with Pi camera" : "Capture bin with Pi camera"} error={audit.error} />
  );
}

function ComparisonImage({ label, src }: { label: string; src: string | null }) {
  return <figure className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
    <div className="flex aspect-[4/3] items-center justify-center bg-black/20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={label} className="h-full w-full object-contain" />
        : <span className="text-xs text-ink-faint">No previous snapshot</span>}
    </div>
    <figcaption className="border-t border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</figcaption>
  </figure>;
}
