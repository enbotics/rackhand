"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  waitForCameraCapture,
  type CameraCaptureJobView,
} from "@/lib/camera/capture-client";
import { warehouseBrowserSessionId } from "@/lib/warehouse/browser-session";
import {
  WAREHOUSE_SESSION_HEADER,
  WAREHOUSE_SESSION_QUERY,
} from "@/lib/warehouse/workflow-session";
import {
  type PutawayCaptureDecision,
  type PutawayCaptureView,
} from "@/lib/warehouse/putaway-capture-types";
import type {
  AuditCaptureDecision,
  AuditCaptureView,
} from "@/lib/warehouse/audit-capture-types";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, Metric } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";

interface PendingCapture {
  captureId: string;
  binCode: string;
  partName?: string;
  purpose: "AUDIT" | "PUTAWAY";
  captureMode: "PROD" | "SIMULATION";
}
type CaptureDecision = PutawayCaptureDecision | AuditCaptureDecision;
type CaptureAnalysis = PutawayCaptureView | AuditCaptureView;
const AUTO_RETURN_DELAY_SECONDS = 5;

/** "putaway" | "audits" — the API route segment for this purpose. */
function captureRouteKind(
  purpose: PendingCapture["purpose"],
): "putaway" | "audits" {
  return purpose === "PUTAWAY" ? "putaway" : "audits";
}
interface CaptureState {
  pending: PendingCapture | null;
  submitting: boolean;
  result: "success" | "failure" | null;
  analysis: CaptureAnalysis | null;
  deciding: boolean;
  reanalyzing: boolean;
  error: string | null;
  cameraJob: CameraCaptureJobView | null;
  reanalyze: () => Promise<void>;
  decide: (decision: CaptureDecision) => Promise<void>;
  close: () => void;
}
const CaptureContext = createContext<CaptureState | null>(null);
export function useAuditCapture() {
  const value = useContext(CaptureContext);
  if (!value) throw new Error("AuditCaptureProvider is missing");
  return value;
}

/** Single physical-verification request owner above navigation. */
export function AuditCaptureProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CaptureState["result"]>(null);
  const [analysis, setAnalysis] = useState<CaptureAnalysis | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraJob, setCameraJob] = useState<CameraCaptureJobView | null>(null);
  const inFlight = useRef(false);
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    const sessionId = warehouseBrowserSessionId();
    const source = new EventSource(
      `/api/warehouse/captures/events?${WAREHOUSE_SESSION_QUERY}=${encodeURIComponent(sessionId)}`,
    );
    const handlePending = (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as {
          captureId: string | null;
          binCode?: string;
          partName?: string;
          purpose?: "PUTAWAY" | "AUDIT";
          captureMode?: "PROD" | "SIMULATION";
          analysis?: CaptureAnalysis | null;
          cameraJob?: CameraCaptureJobView | null;
        };
        if (!data.captureId) {
          // CAPTURING is briefly absent from the pending query while the
          // browser's own request is still following its job stream. Ignore
          // that transient gap, but otherwise let durable server state close
          // a comparison that expired or was completed elsewhere.
          if (inFlight.current) return;
          handledId.current = null;
          setPending(null);
          setAnalysis(null);
          setResult(null);
          setCameraJob(null);
          setError(null);
          return;
        }
        if (data.captureId && data.purpose) {
          if (data.cameraJob) setCameraJob(data.cameraJob);
          // An analyzed result is authoritative even while a retry is still
          // awaiting the separate per-job stream. Ignoring this event while
          // inFlight creates a race where one missed job update hides a result
          // that has already been committed to the database.
          if (inFlight.current && !data.analysis) return;
          if (data.captureId === handledId.current && !data.analysis) return;
          setPending((previous) =>
            previous?.captureId === data.captureId
              ? {
                  ...previous,
                  partName: data.partName ?? previous.partName,
                }
              : {
                  captureId: data.captureId!,
                  binCode: data.binCode ?? "bin",
                  partName: data.partName,
                  purpose: data.purpose!,
                  captureMode: data.captureMode ?? "PROD",
                },
          );
          if (data.analysis) {
            // Restore an analyzed-but-undecided putaway after navigation,
            // refresh, or an SSE reconnect. The durable row—not component
            // memory—owns whether the operator still needs to act.
            setAnalysis(data.analysis);
            setResult("success");
          } else {
            // The server only emits the next bin after the preceding result
            // was acknowledged/confirmed. Clear the preceding presentation
            // when that new, authoritative capture id arrives.
            setAnalysis(null);
            setResult(null);
          }
        }
      } catch {
        /* A later authoritative Realtime event will replace malformed data. */
      }
    };
    source.addEventListener("pending", handlePending);
    return () => {
      source.removeEventListener("pending", handlePending);
      source.close();
    };
  }, []);

  /** The actual capture attempt, with no gate on `result` — used both by the
   * manual capture button and to auto-run the next attempt right after a
   * RETRY decision succeeds, instead of making the operator click twice. */
  async function runCapture() {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setCameraJob(null);
    setError(null);
    try {
      const sessionId = warehouseBrowserSessionId();
      const kind = captureRouteKind(pending.purpose);
      const response = await fetch(
        `/api/warehouse/${kind}/captures/${pending.captureId}`,
        {
          method: "POST",
          headers: { [WAREHOUSE_SESSION_HEADER]: sessionId },
        },
      );
      const requested = (await response.json()) as {
        captureMode?: "PROD" | "SIMULATION";
        captureJobId?: string;
        result?: CaptureAnalysis;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          requested.error?.message ??
            "Physical verification could not be started.",
        );
      }
      if (requested.captureMode === "SIMULATION" && requested.result) {
        handledId.current = pending.captureId;
        setAnalysis(requested.result);
        setResult("success");
        return;
      }
      if (!requested.captureJobId) {
        throw new Error(
          requested.error?.message ??
            (pending.captureMode === "SIMULATION"
              ? "Automatic verification could not be started."
              : "Physical verification could not be started."),
        );
      }
      const completed = await waitForCameraCapture<CaptureAnalysis>(
        requested.captureJobId,
        {
          sessionId,
          onStatus: (job) => setCameraJob(job),
          // The durable server state owns recovery. The browser follows the
          // Realtime stream until a terminal state instead of inventing a
          // second, shorter timeout.
        },
      );
      if (!completed.result)
        throw new Error("Physical verification did not return a result.");
      handledId.current = pending.captureId;
      setCameraJob(completed);
      setAnalysis(completed.result);
      setResult("success");
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "Physical verification failed.",
      );
      setResult(null);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function reanalyze() {
    if (!pending || pending.purpose === "AUDIT" || inFlight.current) return;
    const previousAnalysis = analysis;
    inFlight.current = true;
    setSubmitting(true);
    setReanalyzing(true);
    setResult(null);
    setError(null);
    try {
      const sessionId = warehouseBrowserSessionId();
      const kind = captureRouteKind(pending.purpose);
      const response = await fetch(
        `/api/warehouse/${kind}/captures/${pending.captureId}/reanalyze`,
        {
          method: "POST",
          headers: { [WAREHOUSE_SESSION_HEADER]: sessionId },
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        result?: CaptureAnalysis;
        error?: { message?: string };
      };
      if (!response.ok || !body.result) {
        throw new Error(
          body.error?.message ?? "The saved photo could not be analyzed again.",
        );
      }
      handledId.current = pending.captureId;
      setAnalysis(body.result);
      setResult("success");
    } catch (analysisError) {
      setAnalysis(previousAnalysis);
      setResult(previousAnalysis ? "success" : null);
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "The saved photo could not be analyzed again.",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      setReanalyzing(false);
    }
  }

  async function decide(decision: CaptureDecision) {
    if (!pending || deciding) return;
    setDeciding(true);
    setError(null);
    try {
      const sessionId = warehouseBrowserSessionId();
      const kind = captureRouteKind(pending.purpose);
      const response = await fetch(
        `/api/warehouse/${kind}/captures/${pending.captureId}/decision`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [WAREHOUSE_SESSION_HEADER]: sessionId,
          },
          body: JSON.stringify({ decision }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        if (response.status === 409) {
          // The server is authoritative: an expired/already-decided capture
          // is no longer actionable. Do not reopen a stale comparison after
          // its exit animation merely to repeat the same terminal error.
          handledId.current = null;
          setResult(null);
          setAnalysis(null);
          setPending(null);
          setCameraJob(null);
          return;
        }
        throw new Error(
          body.error?.message ??
            "The verification decision could not be applied.",
        );
      }
      if (decision === "RETRY") {
        handledId.current = null;
        setResult(null);
        setAnalysis(null);
        setCameraJob(null);
        // The Retry click IS the operator's "go again" signal — don't make
        // them confirm a second time on the popup that reappears after it.
        void runCapture();
      } else {
        setResult(null);
        setAnalysis(null);
        setPending(null);
        setCameraJob(null);
      }
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "The verification decision could not be applied.",
      );
    } finally {
      setDeciding(false);
    }
  }

  function close() {
    if (inFlight.current) return;
    setResult(null);
    setAnalysis(null);
    setPending(null);
    setError(null);
    setCameraJob(null);
  }

  return (
    <CaptureContext.Provider
      value={{
        pending,
        submitting,
        result,
        analysis,
        deciding,
        reanalyzing,
        error,
        cameraJob,
        reanalyze,
        decide,
        close,
      }}
    >
      {children}
      <AuditCaptureDialog />
    </CaptureContext.Provider>
  );
}

const AUDIT_COPY: Record<
  AuditCaptureView["outcome"],
  {
    headline: string;
    tone: "success" | "warn";
    message: (view: AuditCaptureView) => string;
    primary: {
      label: string | ((view: AuditCaptureView) => string);
      decision: AuditCaptureDecision;
    };
    secondary?: { label: string; decision: AuditCaptureDecision };
  }
> = {
  VERIFIED: {
    headline: "Verified",
    tone: "success",
    message: () => "Recorded quantity confirmed — nothing was changed.",
    primary: { label: "Done", decision: "ACCEPT" },
  },
  AUTO_RECONCILED: {
    headline: "Higher count detected",
    tone: "success",
    message: (view) =>
      `Click update to record ${view.observedQuantity ?? "—"}; otherwise the bin returns unchanged when the timer ends.`,
    primary: {
      label: (view) => `Update to ${view.observedQuantity ?? ""}`,
      decision: "ACCEPT",
    },
  },
  REVIEW_DECREASE: {
    headline: "Confirm the lower count",
    tone: "warn",
    message: (view) =>
      `Recorded quantity ${view.expectedQuantity}; observed quantity ${view.observedQuantity ?? "—"}.`,
    primary: {
      label: (view) => `Confirm ${view.observedQuantity ?? ""} and continue`,
      decision: "ACCEPT",
    },
    secondary: { label: "Retry photo", decision: "RETRY" },
  },
  FOREIGN_OBJECTS: {
    headline: "Unexpected object detected",
    tone: "warn",
    message: (view) =>
      `Remove: ${view.foreignObjects.length ? view.foreignObjects.join(", ") : "the unexpected object"}.`,
    primary: { label: "Removed · retry photo", decision: "RETRY" },
  },
  LOW_CONFIDENCE: {
    headline: "Needs a clearer photo",
    tone: "warn",
    message: (view) =>
      view.notes ||
      "The count is not confident enough to act on. Improve the view and retry.",
    primary: { label: "Retry photo", decision: "RETRY" },
  },
  CAPACITY_EXCEEDED: {
    headline: "Exceeds bin capacity",
    tone: "warn",
    message: (view) =>
      `Observed quantity ${view.observedQuantity ?? "—"} exceeds this bin's capacity. Correct the contents, then retry.`,
    primary: { label: "Retry photo", decision: "RETRY" },
  },
};

/** Preview -> dismiss -> warehouse scanning animation -> result popup. */
export function AuditCaptureDialog() {
  const audit = useAuditCapture();
  const [closing, setClosing] = useState(false);
  const [autoReturnClock, setAutoReturnClock] = useState<{
    key: string | null;
    seconds: number;
  }>({ key: null, seconds: AUTO_RETURN_DELAY_SECONDS });
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

  const automaticDecision: CaptureDecision | null =
    !audit.pending || audit.result !== "success" || !audit.analysis
      ? null
      : audit.pending.purpose === "AUDIT"
        ? "AUTO_RETURN"
        : ["INCREASED", "REVIEW_DECREASE"].includes(
              (audit.analysis as PutawayCaptureView).outcome,
            )
          ? "ACCEPT"
          : (audit.analysis as PutawayCaptureView).outcome === "READY"
            ? "ACCEPT"
            : null;
  const autoReturnKey = automaticDecision
    ? `${audit.pending!.captureId}:${audit.analysis!.status}:${audit.analysis!.outcome}:${automaticDecision}`
    : null;
  const autoReturnSeconds =
    autoReturnClock.key === autoReturnKey
      ? autoReturnClock.seconds
      : AUTO_RETURN_DELAY_SECONDS;

  useEffect(() => {
    if (!autoReturnKey || closing || audit.deciding) return;

    const deadline = Date.now() + AUTO_RETURN_DELAY_SECONDS * 1_000;
    const countdown = window.setInterval(() => {
      setAutoReturnClock({
        key: autoReturnKey,
        seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
      });
    }, 1_000);
    const autoReturn = window.setTimeout(() => {
      if (pendingDecision.current !== null || !automaticDecision) return;
      pendingDecision.current = automaticDecision;
      setClosing(true);
    }, AUTO_RETURN_DELAY_SECONDS * 1_000);

    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(autoReturn);
    };
  }, [audit.deciding, autoReturnKey, automaticDecision, closing]);

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
    const simulation = result?.captureMode === "SIMULATION";
    const canAccept =
      result &&
      ["READY", "INCREASED", "REVIEW_DECREASE"].includes(result.outcome);
    const inventoryMismatch =
      result !== null &&
      ["INCREASED", "REVIEW_DECREASE"].includes(result.outcome);
    const verificationStatus = !result
      ? "Checking"
      : canAccept
        ? "Verified"
        : "Not verified";
    const warning =
      result?.outcome === "ANALYSIS_FAILED"
        ? {
            headline: "Physical check failed",
            message:
              result.notes ||
              "The saved frame could not be analyzed. Retry analysis without taking another photo.",
          }
        : result?.outcome === "FOREIGN_OBJECTS" ||
            result?.outcome === "LOW_CONFIDENCE"
          ? {
              headline: "Physical check uncertain",
              message:
                "Scale and visual evidence do not agree clearly enough. Inventory was not changed. Engineer check required.",
            }
          : result?.outcome === "CAPACITY_EXCEEDED"
            ? {
                headline: "Physical check needs attention",
                message:
                  "The estimated quantity exceeds this bin’s capacity. Correct the contents or choose another bin.",
              }
            : audit.result === "failure"
              ? {
                  headline: "Physical check failed",
                  message: `The image could not be analyzed. ${simulation ? "Run the next simulated capture." : "Take a fresh photo and retry."}`,
                }
              : null;
    const partName = audit.pending.partName?.trim() || "Bin contents";
    const retrieving = result?.operation === "RETRIEVAL";
    return (
      <Modal
        title={`Physical verification · ${partName}`}
        onClose={() => {}}
        closing={closing}
        onExitComplete={completeDecision}
        dismissible={false}
        maxWidthClassName="max-w-3xl"
      >
        <div className="space-y-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Bin {audit.pending.binCode}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ComparisonImage
              label={simulation ? "Simulation baseline" : "Previous snapshot"}
              src={result?.previousImageUrl ?? null}
            />
            <ComparisonImage
              label={simulation ? "Simulated capture" : "Current verification"}
              src={result?.currentImageUrl ?? null}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="Recorded"
              value={result?.expectedQuantity ?? "—"}
            />
            <Metric
              label={canAccept ? result?.isReturn ? "Remaining" : "Counted" : "Estimated"}
              value={result?.observedQuantity ?? "—"}
              tone={result?.outcome === "REVIEW_DECREASE" ? "warn" : "accent"}
            />
            <Metric
              label="Decision"
              value={verificationStatus}
              tone={canAccept ? "ok" : "warn"}
            />
          </div>
          {result?.totalWeightGrams != null && (
            <div>
              {result.weightSource === "FALLBACK" && (
                <p className="mb-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                  Scale unavailable · using the configured{" "}
                  {result.totalWeightGrams} g fallback total.
                </p>
              )}
              {result.weightSource === "SIMULATION" && (
                <p className="mb-2 text-xs text-ink-faint">Simulated scale reading · not a physical measurement</p>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric
                  label="Total weight"
                  value={result.totalWeightGrams}
                  unit="g"
                />
                <Metric
                  label="Box tare"
                  value={result.tareWeightGrams ?? "—"}
                  unit="g"
                />
                <Metric
                  label="Net weight"
                  value={result.netWeightGrams ?? "—"}
                  unit="g"
                />
                <Metric
                  label="Each item"
                  value={result.unitWeightGrams ?? "—"}
                  unit="g"
                  tone="accent"
                />
              </div>
            </div>
          )}
          {inventoryMismatch && result && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
              <p className="font-semibold uppercase tracking-wide">
                Inventory mismatch found
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                RackHand corrected inventory: {result.expectedQuantity} →{" "}
                {result.observedQuantity}
              </p>
              {result.isReturn && <p className="mt-1 text-xs">Remaining in bin: {result.observedQuantity} · inventory updated</p>}
              <p className="mt-1 text-xs font-medium">{retrieving ? "✓ Bin ready at checkout automatically" : "✓ Returning bin automatically"}</p>
            </div>
          )}
          {warning && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
              <p className="font-semibold uppercase tracking-wide">{warning.headline}</p>
              <p className="mt-1 text-xs leading-relaxed">{warning.message}</p>
            </div>
          )}
          {autoReturnKey && !inventoryMismatch && !retrieving && (
            <AutoReturnNotice seconds={autoReturnSeconds} />
          )}
          {audit.error && <p className="text-xs text-danger">{audit.error}</p>}
          {!inventoryMismatch && <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision("CANCEL")}
              className={BUTTON_VARIANTS.danger}
            >
              {retrieving ? "Cancel check" : "Cancel putaway"}
            </button>
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision("RETRY")}
              className={BUTTON_VARIANTS.secondary}
            >
              {simulation
                ? result?.outcome === "FOREIGN_OBJECTS"
                  ? "Removed · retry check"
                  : "Retry check"
                : result?.outcome === "FOREIGN_OBJECTS"
                  ? "Removed · retry photo"
                  : "Retry photo"}
            </button>
            {result?.outcome === "ANALYSIS_FAILED" && !simulation && (
              <button
                type="button"
                disabled={audit.deciding || audit.submitting || closing}
                onClick={() => void audit.reanalyze()}
                className={BUTTON_VARIANTS.approve}
              >
                Retry analysis
              </button>
            )}
            {canAccept && (
              <button
                type="button"
                disabled={audit.deciding || closing}
                onClick={() => beginDecision("ACCEPT")}
                className={BUTTON_VARIANTS.approve}
              >
                {result?.outcome === "REVIEW_DECREASE"
                  ? `Confirm ${result.observedQuantity} & continue`
                  : retrieving ? "Continue retrieval" : "Continue putaway"}
              </button>
            )}
          </div>}
        </div>
      </Modal>
    );
  }

  // status !== "ACCEPTED" is what actually distinguishes "still needs a
  // decision or a dismissal" from an already fully-closed-out result — an
  // unexpected-stock capture finalizes straight to ACCEPTED server-side
  // (nothing on file to confirm or retry against), so it falls through to
  // the plain fallback screen below instead of offering a stale "Retry".
  if (
    audit.result !== null &&
    audit.pending.purpose === "AUDIT" &&
    audit.result === "success" &&
    (audit.analysis as AuditCaptureView).status !== "ACCEPTED"
  ) {
    const result = audit.analysis as AuditCaptureView;
    const simulation = result.captureMode === "SIMULATION";
    const copy = AUDIT_COPY[result.outcome];
    return (
      <Modal
        title={`Audit comparison · ${audit.pending.binCode}`}
        onClose={() => {}}
        closing={closing}
        onExitComplete={completeDecision}
        dismissible={false}
        maxWidthClassName="max-w-3xl"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ComparisonImage
              label={
                simulation
                  ? "Simulation baseline"
                  : "Previous accepted snapshot"
              }
              src={result.previousImageUrl}
            />
            <ComparisonImage
              label={
                simulation ? "Simulated capture" : "Newly captured snapshot"
              }
              src={result.currentImageUrl}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Recorded qty" value={result.expectedQuantity} />
            <Metric
              label="Observed qty"
              value={result.observedQuantity ?? "—"}
              tone={copy.tone === "warn" ? "warn" : "accent"}
            />
            <Metric
              label="Confidence"
              value={result.confidencePercent ?? "—"}
              unit={result.confidencePercent == null ? undefined : "%"}
              tone={(result.confidencePercent ?? 0) > 80 ? "ok" : "warn"}
            />
          </div>
          <div
            className={`rounded-xl border p-3 text-sm ${copy.tone === "warn" ? "border-warn/40 bg-warn-soft text-warn" : "border-success/40 bg-success-soft text-success"}`}
          >
            <p className="font-semibold">{copy.headline}</p>
            <p className="mt-1 text-xs leading-relaxed">
              {copy.message(result)}
            </p>
          </div>
          <AutoReturnNotice seconds={autoReturnSeconds} />
          {result.notes && result.outcome !== "LOW_CONFIDENCE" && (
            <p className="text-xs text-ink-muted">{result.notes}</p>
          )}
          {audit.error && <p className="text-xs text-danger">{audit.error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {(result.outcome === "REVIEW_DECREASE" ||
              copy.primary.decision === "RETRY") && (
              <button
                type="button"
                disabled={audit.deciding || closing}
                onClick={() => beginDecision("DISMISS")}
                className={BUTTON_VARIANTS.secondary}
              >
                Skip · keep recorded qty
              </button>
            )}
            {copy.secondary && (
              <button
                type="button"
                disabled={audit.deciding || closing}
                onClick={() => beginDecision(copy.secondary!.decision)}
                className={BUTTON_VARIANTS.secondary}
              >
                {simulation && copy.secondary.decision === "RETRY"
                  ? "Run next simulation"
                  : copy.secondary.label}
              </button>
            )}
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision(copy.primary.decision)}
              className={
                copy.primary.decision === "ACCEPT"
                  ? BUTTON_VARIANTS.approve
                  : BUTTON_VARIANTS.secondary
              }
            >
              {copy.primary.decision === "RETRY" && simulation
                ? result.outcome === "FOREIGN_OBJECTS"
                  ? "Removed · next simulation"
                  : "Run next simulation"
                : typeof copy.primary.label === "function"
                  ? copy.primary.label(result)
                  : copy.primary.label}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (audit.result !== null)
    return (
      <Modal
        title={`Capture · ${audit.pending.binCode}`}
        onClose={audit.close}
        maxWidthClassName="max-w-lg"
      >
        <div className="space-y-4">
          <p
            className={
              audit.result === "success" ? "text-success" : "text-danger"
            }
          >
            {audit.result === "success"
              ? "Frame analyzed"
              : "Capture could not be confirmed"}
          </p>
          <p className="text-sm text-ink-muted">
            {audit.result === "failure"
              ? "Audit capture failed. Follow the safe return and review outcome in the RackHand Agent conversation."
              : "Photo verification finished. Follow the audit result in the RackHand Agent conversation."}
          </p>
          <button
            type="button"
            onClick={audit.close}
            className={BUTTON_VARIANTS.secondary}
          >
            Back to warehouse
          </button>
        </div>
      </Modal>
    );
  const partName = audit.pending.partName?.trim() || "Bin contents";
  return (
    <Modal
      title="Physical verification"
      onClose={() => {}}
      dismissible={false}
      maxWidthClassName="max-w-md"
    >
      <div className="rounded-2xl border border-line bg-bg-elevated p-6 text-center">
        <p className="text-sm font-semibold text-ink">
          {partName}{" "}
          <span className="text-ink-muted">
            · Bin {audit.pending.binCode}
          </span>
        </p>
        <CaptureSpinner />
        <p
          className="mt-4 text-sm font-semibold text-ink"
          role="status"
          aria-live="polite"
        >
          Camera + scale checking contents…
        </p>
        <div className="mt-4 flex items-center justify-center gap-2 text-xs font-medium text-success">
          <span className="h-2 w-2 animate-breathe rounded-full bg-success" aria-hidden />
          <span>Verifying physical inventory</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          Automatic check — no action needed
        </p>
      </div>
    </Modal>
  );
}

function AutoReturnNotice({ seconds }: { seconds: number }) {
  return (
    <p
      className="rounded-lg border border-line bg-bg-elevated px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted"
      role="status"
      aria-live="polite"
    >
      Returning bin unchanged in {seconds}s · inventory quantity will not be
      updated
    </p>
  );
}

/**
 * The physical verification dialog needs a quiet sign of life while the
 * automatic check is running. A rotating ring shows that work is continuing.
 *
 * Reduced motion is honoured by .animate-spin-slow itself (globals.css), and
 * the ring is decorative: the status text carries the state for screen readers.
 */
function CaptureSpinner() {
  return (
    <div
      aria-hidden
      className="mx-auto mt-5 h-8 w-8 animate-spin-slow rounded-full border-2 border-line border-t-accent"
    />
  );
}

function ComparisonImage({
  label,
  src,
}: {
  label: string;
  src: string | null;
}) {
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
      <div className="flex aspect-[4/3] items-center justify-center bg-black/20">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="text-xs text-ink-faint">No previous snapshot</span>
        )}
      </div>
      <figcaption className="border-t border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
        {label}
      </figcaption>
    </figure>
  );
}
