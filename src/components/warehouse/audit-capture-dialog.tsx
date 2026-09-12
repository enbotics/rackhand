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
import type {
  PutawayCaptureDecision,
  PutawayCaptureView,
} from "@/lib/warehouse/putaway-capture-types";
import type {
  AuditCaptureDecision,
  AuditCaptureView,
} from "@/lib/warehouse/audit-capture-types";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, Metric } from "./ui";
import { usePrefersReducedMotion } from "./use-reduced-motion";
import { useCameraHealth } from "./camera-health-provider";

interface PendingCapture {
  captureId: string;
  binCode: string;
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

/** Single Pi-capture request owner above navigation. */
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
              ? previous
              : {
                  captureId: data.captureId!,
                  binCode: data.binCode ?? "bin",
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
          requested.error?.message ?? "The capture could not be requested.",
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
              ? "The simulated capture could not be started."
              : "The Raspberry Pi capture could not be requested."),
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
        throw new Error("The capture completed without an analysis result.");
      handledId.current = pending.captureId;
      setCameraJob(completed);
      setAnalysis(completed.result);
      setResult("success");
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "The capture failed.",
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
  const { health } = useCameraHealth();
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

  const autoReturnKey =
    audit.pending && audit.result === "success" && audit.analysis
      ? `${audit.pending.captureId}:${audit.analysis.status}:${audit.analysis.outcome}`
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
      if (pendingDecision.current !== null) return;
      pendingDecision.current = "AUTO_RETURN";
      setClosing(true);
    }, AUTO_RETURN_DELAY_SECONDS * 1_000);

    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(autoReturn);
    };
  }, [audit.deciding, autoReturnKey, closing]);

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
    const retryCapture = simulation
      ? "run the next simulated capture"
      : "take a fresh photo";
    const canAccept =
      result &&
      ["READY", "INCREASED", "REVIEW_DECREASE"].includes(result.outcome);
    const warning =
      result?.outcome === "ANALYSIS_FAILED"
        ? result.notes || "The saved frame could not be analyzed. Retry analysis without taking another photo."
        : result?.outcome === "FOREIGN_OBJECTS"
        ? `Remove ${result.foreignObjects.length ? result.foreignObjects.join(", ") : "the unexpected object"}, then ${retryCapture}.`
        : result?.outcome === "LOW_CONFIDENCE"
          ? "The count is not confident enough to change inventory. Improve the view and retry."
          : result?.outcome === "CAPACITY_EXCEEDED"
            ? "The observed quantity exceeds this bin’s capacity. Correct the contents or choose another bin."
            : audit.result === "failure"
              ? `The image could not be analyzed. ${simulation ? "Run the next simulated capture." : "Take a fresh photo and retry."}`
              : null;
    return (
      <Modal
        title={`Putaway comparison · ${audit.pending.binCode}`}
        onClose={() => {}}
        closing={closing}
        onExitComplete={completeDecision}
        dismissible={false}
        maxWidthClassName="max-w-3xl"
      >
        <div className="space-y-4">
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
              label="Recorded qty"
              value={result?.expectedQuantity ?? "—"}
            />
            <Metric
              label="Observed qty"
              value={result?.observedQuantity ?? "—"}
              tone={result?.outcome === "REVIEW_DECREASE" ? "warn" : "accent"}
            />
            <Metric
              label="Confidence"
              value={result?.confidencePercent ?? "—"}
              unit={result?.confidencePercent == null ? undefined : "%"}
              tone={(result?.confidencePercent ?? 0) > 80 ? "ok" : "warn"}
            />
          </div>
          {result?.totalWeightGrams != null && (
            <div>
              {result.weightSource === "FALLBACK" && (
                <p className="mb-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                  Scale unavailable · using the configured {result.totalWeightGrams} g fallback total.
                </p>
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
          {warning && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
              <p className="font-semibold">Verification needs attention</p>
              <p className="mt-1 text-xs leading-relaxed">{warning}</p>
            </div>
          )}
          {result?.outcome === "INCREASED" && (
            <p className="text-sm text-success">
              Higher quantity detected. Inventory will update automatically
              after the gantry completes putaway.
            </p>
          )}
          {result?.outcome === "REVIEW_DECREASE" && (
            <p className="text-sm text-warn">
              The quantity decreased. Confirm this observed count before
              inventory is changed.
            </p>
          )}
          <AutoReturnNotice seconds={autoReturnSeconds} />
          {result?.notes && result.outcome !== "ANALYSIS_FAILED" && (
            <p className="text-xs text-ink-muted">{result.notes}</p>
          )}
          {audit.error && <p className="text-xs text-danger">{audit.error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision("CANCEL")}
              className={BUTTON_VARIANTS.danger}
            >
              Cancel putaway
            </button>
            <button
              type="button"
              disabled={audit.deciding || closing}
              onClick={() => beginDecision("RETRY")}
              className={BUTTON_VARIANTS.secondary}
            >
              {simulation
                ? result?.outcome === "FOREIGN_OBJECTS"
                  ? "Removed · next simulation"
                  : "Run next simulation"
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
                  : "Continue putaway"}
              </button>
            )}
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
            {(result.outcome === "REVIEW_DECREASE" || copy.primary.decision === "RETRY") && (
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
  if (audit.submitting) {
    const status = audit.cameraJob?.status;
    const position = audit.cameraJob?.queuePosition;
    const headline = audit.reanalyzing
      ? "Reanalyzing the saved photo"
      : status === "PROCESSING" || status === "UPLOADED"
      ? "Analyzing captured frame"
      : status === "CLAIMED" || position === 0
        ? "Pi camera is capturing now"
        : typeof position === "number" && position > 1
          ? `Waiting for Pi camera · position ${position}`
          : typeof position === "number"
            ? "Next in the Pi camera queue"
            : "Joining the Pi camera queue";
    return (
      <Modal
        title={`${audit.reanalyzing ? "Saved photo" : "Camera queue"} · ${audit.pending.binCode}`}
        onClose={() => {}}
        dismissible={false}
        maxWidthClassName="max-w-md"
      >
        <div className="rounded-2xl border border-line bg-bg-elevated p-6 text-center">
          <CaptureSpinner />
          <p
            className="mt-4 text-sm font-semibold text-ink"
            role="status"
            aria-live="polite"
          >
            {headline}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            {audit.reanalyzing
              ? "No new camera capture is being taken. The existing durable frame is being inspected again."
              : "Your request is private to this tab. The Raspberry Pi processes one capture at a time."}
          </p>
          <CameraHealthLine health={health} />
        </div>
      </Modal>
    );
  }
  // Reached while the initial automatic capture is waiting and has no
  // analysis yet. The server owns starting that first job, but the operator
  // must never be trapped here if the Pi or its network goes away: Retry
  // atomically supersedes the active job and starts a new attempt, while
  // Abort terminates this workflow through its normal server-side unwind.
  const waitingTitle =
    audit.pending.purpose === "PUTAWAY" ? "Putaway photo" : "Audit photo";
  const abortDecision: CaptureDecision =
    audit.pending.purpose === "PUTAWAY" ? "CANCEL" : "DISMISS";
  const cameraStatus = audit.cameraJob?.status;
  const queuePosition = audit.cameraJob?.queuePosition;
  const waitingHeadline =
    audit.pending.captureMode === "SIMULATION"
      ? "Running the simulated capture"
      : cameraStatus === "PROCESSING"
      ? "Gemini is analyzing the captured frame"
      : cameraStatus === "UPLOADED"
        ? "Frame uploaded securely"
        : cameraStatus === "CLAIMED"
          ? "Pi camera is capturing now"
          : cameraStatus === "FAILED" || cameraStatus === "CANCELLED" || cameraStatus === "EXPIRED"
            ? "Pi capture needs attention"
            : health?.connection === "OFFLINE"
              ? "Raspberry Pi is offline"
              : typeof queuePosition === "number" && queuePosition > 1
                ? `Waiting for Pi camera · position ${queuePosition}`
                : cameraStatus === "PENDING"
                  ? "Next in the Pi camera queue"
                  : "Joining the Pi camera queue";
  // A spinner over a dead attempt would claim progress that is not happening,
  // so the ring stops on exactly the states the headline calls out as stuck.
  const waitingStalled =
    cameraStatus === "FAILED" ||
    cameraStatus === "CANCELLED" ||
    cameraStatus === "EXPIRED" ||
    health?.connection === "OFFLINE";
  return (
    <Modal
      title={`${waitingTitle} · ${audit.pending.binCode}`}
      onClose={() => {}}
      dismissible={false}
      maxWidthClassName="max-w-md"
    >
      <div className="rounded-2xl border border-line bg-bg-elevated p-6 text-center">
        <CaptureSpinner stalled={waitingStalled} />
        <p
          className="mt-4 text-sm font-semibold text-ink"
          role="status"
          aria-live="polite"
        >
          {waitingHeadline}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          The photo is captured and analyzed automatically. If the Pi cannot
          complete this attempt, retry it or abort the workflow safely.
        </p>
        {audit.error && <p className="mt-2 text-xs text-danger">{audit.error}</p>}
        {audit.cameraJob?.error && (
          <p className="mt-2 text-xs text-danger">{audit.cameraJob.error.message}</p>
        )}
        <CameraProgress status={cameraStatus} />
        {audit.pending.captureMode === "PROD" && <CameraHealthLine health={health} />}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            disabled={audit.deciding || closing}
            onClick={() => beginDecision(abortDecision)}
            className={BUTTON_VARIANTS.danger}
          >
            {audit.pending.purpose === "PUTAWAY"
              ? "Abort putaway"
              : "Abort audit"}
          </button>
          <button
            type="button"
            disabled={audit.deciding || closing}
            onClick={() => beginDecision("RETRY")}
            className={BUTTON_VARIANTS.secondary}
          >
            Retry Pi capture
          </button>
        </div>
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
      Returning bin unchanged in {seconds}s · inventory quantity will not be updated
    </p>
  );
}

/**
 * The waiting dialogs have no other sign of life: a queued capture can sit for
 * a while with every word on the panel unchanged, which reads as a hung
 * dialog. A rotating ring says the attempt is still moving.
 *
 * It deliberately STOPS when the attempt has stalled — a spinner over a failed
 * capture or an offline Pi would promise progress that is not happening, and
 * the operator's next move is Retry or Abort, not waiting. Reduced motion is
 * honoured by .animate-spin-slow itself (globals.css), and the ring is
 * decorative: the headline beside it carries the state for screen readers.
 */
function CaptureSpinner({ stalled = false }: { stalled?: boolean }) {
  return (
    <div
      aria-hidden
      className={`mx-auto h-8 w-8 rounded-full border-2 border-line ${
        stalled ? "border-t-danger" : "animate-spin-slow border-t-accent"
      }`}
    />
  );
}

function CameraProgress({ status }: { status?: CameraCaptureJobView["status"] }) {
  const stages = ["Queued", "Pi capture", "Uploaded", "Gemini"];
  const current = status === "CLAIMED"
    ? 1
    : status === "UPLOADED"
      ? 2
      : status === "PROCESSING" || status === "COMPLETED"
        ? 3
        : 0;
  const failed = status === "FAILED" || status === "CANCELLED" || status === "EXPIRED";
  return (
    <div
      className="mt-5 grid grid-cols-4 gap-1"
      aria-label={`Camera progress: ${status ?? "connecting"}`}
    >
      {stages.map((stage, index) => (
        <div key={stage} className="min-w-0">
          <div
            className={`h-1 rounded-full transition-colors duration-500 ${
              failed && index === current
                ? "bg-danger"
                : index === current
                  ? "animate-breathe bg-accent"
                  : index < current
                    ? "bg-accent"
                    : "bg-line"
            }`}
          />
          <p className={`mt-1 truncate font-mono text-[8px] uppercase tracking-wide ${
            index <= current ? "text-ink-muted" : "text-ink-faint"
          }`}>
            {stage}
          </p>
        </div>
      ))}
    </div>
  );
}

function CameraHealthLine({
  health,
}: {
  health: ReturnType<typeof useCameraHealth>["health"];
}) {
  const connection = health?.connection ?? "OFFLINE";
  const tone = connection === "ONLINE"
    ? "bg-success"
    : connection === "DEGRADED"
      ? "bg-warn"
      : "bg-danger";
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted">
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
        Pi {connection.toLowerCase()}
      </span>
      {health?.cpuTemperatureC != null && <span>{health.cpuTemperatureC.toFixed(1)}°C</span>}
      {health?.workerState && health.workerState !== "UNKNOWN" && (
        <span>{health.workerState.replaceAll("_", " ")}</span>
      )}
    </div>
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
