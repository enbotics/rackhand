"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addShot,
  deleteShot,
  getAllShots,
  setShotMeasurement,
  type Measurement,
  type Shot,
} from "@/lib/shots-db";
import { measurementToScanResult } from "@/lib/warehouse/scan-result";
import type { CatalogMatchResult } from "@/lib/warehouse/catalog-match-types";
import type { CatalogResolutionRequestResult } from "@/lib/warehouse/catalog-resolution-types";
import {
  deriveScanIdentity,
  describeMeasureFailure,
  type ScanIdentityStatus,
} from "@/lib/warehouse/dashboard-presentation";
import {
  useAgentTrace,
  useGantryStatus,
  useRecentTraces,
  useWarehouseOverview,
} from "@/lib/use-warehouse-data";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import type {
  AgentTurn,
  ApprovalOutcome,
  ConfirmedIdentity,
  CurrentScan,
  PendingApprovalView,
  PendingIdentification,
  ScanState,
} from "./state";
import type {
  BinView,
  InventoryAuditView,
  InventoryRowView,
  MovementRowView,
} from "@/lib/warehouse/dashboard-types";

import type { MeasurementResult, ScanResult } from "@/lib/warehouse/scan-types";

import {
  CameraCaptureClientError,
  createCameraCapture,
  waitForCameraCapture,
  type CameraCaptureJobView,
} from "@/lib/camera/capture-client";

/**
 * One operator session, shared by every page (Milestone 10, split in 13).
 *
 * WHY THIS EXISTS. The command centre used to be one component on one route,
 * so its state and its markup could live together. Splitting the screen into
 * Operate / Warehouse / History / Activity moved the markup apart, and a
 * half-finished scan or a pending approval must NOT be destroyed by clicking
 * a menu item — losing an approval card mid-decision would leave the operator
 * unable to answer a question the server is still holding open. So the state
 * moved up to the layout, where it outlives navigation, and the pages became
 * views of it.
 *
 * WHAT THIS IS: a coordinator. It sequences existing server calls, holds the
 * operator's session state, and re-reads the authoritative warehouse snapshot
 * after anything changes.
 *
 * WHAT IT IS NOT: an owner of warehouse rules. There is no matching, no
 * availability check, no quantity arithmetic and no approval decision here.
 * Every one of those already exists behind an API from Milestones 1-9, and a
 * second copy in the browser would eventually disagree with the first. In
 * particular this NEVER writes to bins, inventory or movements: the only
 * state-changing calls it can make are /api/agent (which stops for approval)
 * and /api/agent/approve (which sends an id and a decision, nothing else).
 *
 * The polling hooks run once here rather than once per page, so four routes
 * do not become four pollers against the same endpoints.
 */

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data: data as Record<string, unknown>,
  };
}

let turnCounter = 0;
function nextTurnId(): string {
  turnCounter += 1;
  return `turn_${turnCounter}`;
}

/**
 * The handle that ties this chat to its server-side conversation memory.
 *
 * sessionStorage, NOT localStorage: it is scoped to this one tab and dies with
 * it. That is the lifetime the operator already sees on screen — reloading
 * clears the transcript, so the agent's memory of it should go too rather than
 * having the agent remember an exchange the operator no longer can. It also
 * means a second tab is a genuinely separate conversation, so two operators at
 * two stations never find their turns merged into one history.
 *
 * The value is opaque and carries no meaning: it authorises nothing, and every
 * word of the conversation it names was written by the server. Losing it costs
 * continuity and nothing else, which is why every failure here degrades to a
 * fresh id instead of an error.
 */
const AGENT_SESSION_STORAGE_KEY = "ugreen:agent-session-id";
let memorySessionId: string | null = null;

function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

function agentSessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(AGENT_SESSION_STORAGE_KEY);
    if (stored) return stored;
    const created = newSessionId();
    window.sessionStorage.setItem(AGENT_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    // Private mode, or storage disabled. One id per page lifetime is still
    // better memory than none, and it never leaves this tab either.
    memorySessionId ??= newSessionId();
    return memorySessionId;
  }
}

const EMPTY_SCAN: ScanState = { phase: "EMPTY", scan: null, failure: null };

export interface WarehouseSession {
  /* ---- authoritative warehouse state (server, re-read on every change) ---- */
  bins: BinView[];
  inventory: InventoryRowView[];
  movements: MovementRowView[];
  latestAudit: InventoryAuditView | null;
  activeMovement: MovementRowView | null;
  totals: {
    units: number;
    distinctParts: number;
    binsAvailable: number;
  } | null;
  loading: boolean;
  overviewError: string | null;
  refresh: () => void;

  gantry: ReturnType<typeof useGantryStatus>["status"];
  gantryError: string | null;

  /* ---- scan session ---- */
  shots: Shot[];
  scanState: ScanState;
  scanning: boolean;
  /* ---- Raspberry Pi camera ---- */
  piCapture: CameraCaptureJobView | null;
  startPiScan: () => void;

  identity: ScanIdentityStatus | null;
  onCapture: (shot: Shot) => void;
  onDeleteShot: (id: string) => void;
  onMeasured: (
    id: string,
    measurement: Measurement,
    scanResult?: ScanResult,
  ) => void;

  /* ---- human decisions ---- */
  identification: PendingIdentification | null;
  confirmed: ConfirmedIdentity | null;
  identityRejected: boolean;
  identityBusy: boolean;
  identityError: string | null;
  /** Increments when the agent asks the operator to continue in the guided dialog. */
  guidedPutawayRequestVersion: number;
  selectCandidate: (partId: string) => void;
  rejectIdentification: () => void;
  /** Opens a fresh audited decision before putaway so an operator can revise an identity. */
  reconsiderIdentification: () => void;
  /** Registers a NO_MATCH scan as a brand-new catalog part, then re-checks the match. */
  registerNewPart: () => void;
  registeringPart: boolean;
  registerError: string | null;

  approval: PendingApprovalView | null;
  outcome: ApprovalOutcome | null;
  decide: (decision: "APPROVE" | "DENY") => void;
  /** True when anything is waiting on, or has just been answered by, a person. */
  hasDecision: boolean;

  /* ---- agent ---- */
  turns: AgentTurn[];
  agentBusy: boolean;
  agentError: string | null;
  agentUnavailable: boolean;
  send: (message: string) => void;
  retryLast: () => void;

  /* ---- workflow and observability ---- */
  workflow: WarehouseGraphResult | null;
  trace: ReturnType<typeof useAgentTrace>["trace"];
  traceError: string | null;
  recentTraces: ReturnType<typeof useRecentTraces>["traces"];
  selectTrace: (traceId: string) => void;
}

const SessionContext = createContext<WarehouseSession | null>(null);

/** The session for the current operator. Throws outside the provider, on purpose. */
export function useWarehouseSession(): WarehouseSession {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error(
      "useWarehouseSession must be used inside <WarehouseSessionProvider>.",
    );
  }
  return session;
}

export function WarehouseSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Local scan history (IndexedDB). Never warehouse authority.
  const [shots, setShots] = useState<Shot[]>([]);

  // Current scan session.
  const [scanState, setScanState] = useState<ScanState>(EMPTY_SCAN);

  const [piCapture, setPiCapture] = useState<CameraCaptureJobView | null>(null);

  /**
   * Synchronous guard against two fast clicks before React
   * has had time to update scanState.
   */
  const piScanInFlightRef = useRef(false);

  const [identification, setIdentification] =
    useState<PendingIdentification | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedIdentity | null>(null);
  const [identityRejected, setIdentityRejected] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [registeringPart, setRegisteringPart] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [guidedPutawayRequestVersion, setGuidedPutawayRequestVersion] =
    useState(0);

  // Agent conversation.
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentUnavailable, setAgentUnavailable] = useState(false);
  const [approval, setApproval] = useState<PendingApprovalView | null>(null);
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  /**
   * The last Strands graph run (Milestone 11). Server-composed workflow state,
   * arriving on the agent reply — the browser never runs or imports a graph.
   */
  const [workflow, setWorkflow] = useState<WarehouseGraphResult | null>(null);
  /**
   * The trace being followed (Milestone 12). Always a SERVER-generated id that
   * arrived on an agent reply, or one the operator picked from history — the
   * browser never invents one.
   */
  const [traceId, setTraceId] = useState<string | null>(null);
  const lastOperatorMessage = useRef<string | null>(null);

  // Authoritative warehouse state.
  const [actionInFlight, setActionInFlight] = useState(false);
  const { overview, loading, error: overviewError, refresh } =
    useWarehouseOverview(actionInFlight || agentBusy);
  const { trace, error: traceError } = useAgentTrace(traceId);
  const { traces: recentTraces, refresh: refreshTraces } = useRecentTraces();
  const { status: gantry, error: gantryError } = useGantryStatus(
    actionInFlight || agentBusy || overview?.latestAudit?.status === "RUNNING",
  );

  useEffect(() => {
    getAllShots()
      .then(setShots)
      // A browser with IndexedDB blocked still gets a working command centre;
      // it just has no local history.
      .catch(() => setShots([]));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setShots((previous) => previous.filter((shot) => shot.id !== id));
    deleteShot(id).catch(() => {});
  }, []);

  /** Re-measuring an old shot from the lightbox keeps local history in step. */
  const handleMeasured = useCallback(
    (id: string, measurement: Measurement, scanResult?: ScanResult) => {
      setShots((previous) =>
        previous.map((shot) =>
          shot.id === id ? { ...shot, measurement, scanResult } : shot,
        ),
      );
    },
    [],
  );

  const beginNewScan = useCallback(() => {
    /*
     * A new physical scan invalidates operator decisions
     * attached to the previous scan.
     */
    setIdentification(null);

    setConfirmed(null);

    setIdentityRejected(false);

    setIdentityError(null);

    setRegisterError(null);

    /*
     * Old Pi status must not remain attached to a new scan.
     */
    setPiCapture(null);

    setScanState({
      phase: "MEASURING",
      scan: null,
      failure: null,
    });
  }, []);

  const requestIdentification = useCallback(
    async (scanResult: ScanResult): Promise<boolean> => {
      setIdentityBusy(true);
      setIdentityError(null);
      try {
        const { data } = await postJson("/api/warehouse/catalog/resolutions", {
          scanResult,
        });
        const result = data as unknown as CatalogResolutionRequestResult;
        if (result.status === "HUMAN_DECISION_REQUIRED") {
          setIdentification({
            resolutionId: result.resolutionId,
            scanId: result.scanId,
            reason: result.reason,
            expiresAt: result.expiresAt,
            candidates: result.candidates,
          });
          return true;
        }
        // MATCHED / NO_MATCH / RESCAN_REQUIRED need no card: the scan panel
        // already shows the matcher's verdict, and none of them is resolvable.
      } catch {
        setIdentityError("The identification service could not be reached.");
        return false;
      } finally {
        setIdentityBusy(false);
      }
      return false;
    },
    [],
  );

  const applyMeasurementResult = useCallback(
    async ({
      measurementResult,
      shot,
    }: {
      measurementResult: MeasurementResult;
      shot: Shot;
    }) => {
      /*
       * Measurement is the local-history version of
       * MeasurementResult. The only additional field is measuredAt.
       */
      const measurement: Measurement = {
        ...measurementResult,

        observedQuantity: measurementResult.observedQuantity ?? 1,

        quantityConfidence: measurementResult.quantityConfidence ?? 1,

        measuredAt: Date.now(),
      };

      /*
       * This remains the ONE canonical point where
       * measurement becomes warehouse evidence.
       */
      const conversion = measurementToScanResult(measurement, {
        capturedAt: shot.createdAt,
      });

      const scanResult = conversion.ok ? conversion.scanResult : null;

      /*
       * IndexedDB is local scan history only.
       * It is not warehouse authority.
       */
      setShotMeasurement(shot.id, measurement, scanResult ?? undefined).catch(
        () => {},
      );

      setShots((previous) =>
        previous.map((item) =>
          item.id === shot.id
            ? {
                ...item,

                measurement,

                scanResult: scanResult ?? undefined,
              }
            : item,
        ),
      );

      const scan: CurrentScan = {
        shotId: shot.id,

        capturedAt: shot.createdAt,

        measurement,

        scanResult,

        issues: conversion.ok ? [] : conversion.issues,

        match: null,

        matchError: null,
      };

      /*
       * A measurement that does not satisfy ScanResult
       * can still be displayed, but cannot become warehouse
       * evidence.
       */
      if (!scanResult) {
        setScanState({
          phase: "READY",
          scan,
          failure: null,
        });

        return;
      }

      /*
       * Now enter the exact same catalog matcher used
       * by the existing browser scan.
       */
      setScanState({
        phase: "MATCHING",
        scan,
        failure: null,
      });

      try {
        const { ok: matchOk, data } = await postJson(
          "/api/warehouse/catalog/match",
          {
            scanResult,
          },
        );

        if (!matchOk) {
          throw new Error("Catalog match failed");
        }

        const match = data as unknown as CatalogMatchResult;

        setScanState({
          phase: "READY",

          scan: {
            ...scan,
            match,
          },

          failure: null,
        });

        /*
         * Preserve existing HITL behavior.
         */
        if (match.status === "AMBIGUOUS") {
          await requestIdentification(scanResult);
        }
      } catch {
        /*
         * Measurement remains valid even if catalog matching
         * is temporarily unavailable.
         */
        setScanState({
          phase: "READY",

          scan: {
            ...scan,
            matchError: "unavailable",
          },

          failure: null,
        });
      }
    },
    [requestIdentification],
  );

  /**
   * capture -> measure -> ScanResult -> catalog match.
   *
   * Ends there, deliberately. Scanning identifies a part; it never puts one
   * away. The physical action is a separate request that a person approves.
   */
  /**
   * Existing browser-camera path.
   *
   * Browser and Raspberry Pi now differ only in how they
   * obtain MeasurementResult.
   *
   * Everything afterward goes through applyMeasurementResult().
   */
  const handleCapture = useCallback(
    async (shot: Shot) => {
      setShots((previous) => [shot, ...previous]);

      addShot(shot).catch(() => {
        /*
         * Local IndexedDB history failing must never stop
         * the warehouse workflow.
         */
      });

      beginNewScan();

      try {
        const response = await fetch("/api/measure", {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            imageDataUrl: shot.dataUrl,

            imageWidthPx: shot.width,

            imageHeightPx: shot.height,
          }),
        });

        const body = (await response.json()) as
          | MeasurementResult
          | {
              error?: {
                code?: unknown;
                message?: unknown;
              };
            };

        if (!response.ok) {
          const failure = "error" in body ? (body.error ?? {}) : {};

          setScanState({
            phase: "FAILED",

            scan: null,

            failure: describeMeasureFailure(failure.code, failure.message),
          });

          return;
        }

        await applyMeasurementResult({
          measurementResult: body as MeasurementResult,

          shot,
        });
      } catch {
        setScanState({
          phase: "FAILED",

          scan: null,

          failure: {
            title: "The measurement service could not be reached.",

            guidance:
              "Check that the application server is running, then scan again.",
          },
        });
      }
    },
    [beginNewScan, applyMeasurementResult],
  );

  const startPiScan = useCallback(async () => {
    /*
     * Prevent duplicate jobs from a rapid double click.
     */
    if (piScanInFlightRef.current) {
      return;
    }

    if (scanState.phase === "MEASURING" || scanState.phase === "MATCHING") {
      return;
    }

    piScanInFlightRef.current = true;

    beginNewScan();

    try {
      /*
       * 1. Create MANUAL_SCAN camera job.
       */
      const created = await createCameraCapture();

      /*
       * 2. Wait for:
       *
       * PENDING
       * → CLAIMED
       * → UPLOADED
       * → PROCESSING
       * → COMPLETED
       */
      const completed = await waitForCameraCapture(created.captureJobId, {
        pollIntervalMs: 1000,

        timeoutMs: 120_000,

        onStatus: (job) => {
          setPiCapture(job);
        },
      });

      /*
       * COMPLETED should always have the measurement result.
       */
      if (!completed.result) {
        throw new CameraCaptureClientError(
          "camera_result_missing",
          "The camera job completed without a measurement result.",
        );
      }

      /*
       * Every physical scan should retain its evidence image.
       */
      if (!completed.evidenceUrl) {
        throw new CameraCaptureClientError(
          "camera_evidence_missing",
          "The camera job completed without image evidence.",
        );
      }

      /*
       * 3. Download the already-stored server JPEG.
       *
       * We convert it to data URL only because the current
       * Shot/IndexedDB/agent pipeline already uses dataUrl.
       *
       * Later we can migrate Shot to evidence URLs if desired.
       */
      const imageResponse = await fetch(completed.evidenceUrl, {
        cache: "no-store",
      });

      if (!imageResponse.ok) {
        throw new CameraCaptureClientError(
          "camera_evidence_fetch_failed",
          "The captured image could not be loaded.",
        );
      }

      const imageBlob = await imageResponse.blob();

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);

            return;
          }

          reject(new Error("Could not encode the captured image."));
        };

        reader.onerror = () => {
          reject(
            reader.error ?? new Error("Could not read the captured image."),
          );
        };

        reader.readAsDataURL(imageBlob);
      });

      /*
       * Prefer the physical Pi capture timestamp,
       * not the time the browser happened to receive the result.
       */
      const capturedAt = completed.capturedAt
        ? new Date(completed.capturedAt).getTime()
        : Date.now();

      if (!Number.isFinite(capturedAt)) {
        throw new CameraCaptureClientError(
          "camera_capture_timestamp_invalid",
          "The camera returned an invalid capture timestamp.",
        );
      }

      /*
       * 4. Adapt the Raspberry Pi capture to the existing Shot model.
       *
       * From this point forward the warehouse no longer needs to know
       * which camera source created the scan.
       */
      const shot: Shot = {
        id: completed.captureJobId,

        dataUrl,

        createdAt: capturedAt,

        width: completed.imageWidth ?? 0,

        height: completed.imageHeight ?? 0,

        deviceLabel: "Raspberry Pi Camera Module 3",
      };

      setShots((previous) => [shot, ...previous]);

      addShot(shot).catch(() => {
        /*
         * Local scan history is not warehouse authority.
         */
      });

      /*
       * 5. Enter the SAME warehouse pipeline
       * as the browser camera.
       */
      await applyMeasurementResult({
        measurementResult: completed.result,

        shot,
      });
    } catch (error) {
      console.error("[camera] Pi scan failed:", error);

      let title = "The Raspberry Pi camera scan failed.";

      let guidance = "Check the Raspberry Pi camera worker and try again.";

      if (error instanceof CameraCaptureClientError) {
        title = error.message;

        switch (error.code) {
          case "camera_job_expired":
            guidance =
              "The Raspberry Pi did not complete the capture before the job expired. Check that the worker is running.";
            break;

          case "camera_capture_timeout":
            guidance =
              "The browser stopped waiting for the camera. Check the Raspberry Pi worker and server logs.";
            break;

          case "measurement_mat_not_detected":
            guidance =
              "Make sure all four calibration markers are visible and the mat is flat.";
            break;

          case "measurement_calibration_failed":
            guidance =
              "Check the calibration mat position and take a clearer image.";
            break;

          case "measurement_no_object_detected":
            guidance =
              "Place the part inside the calibration area and scan again.";
            break;

          case "measurement_multiple_objects":
            guidance =
              "Remove different part types from the calibration mat and scan again.";
            break;

          case "camera_evidence_fetch_failed":
            guidance =
              "The measurement completed, but the captured JPEG could not be loaded from the server.";
            break;
        }
      }

      setScanState({
        phase: "FAILED",

        scan: null,

        failure: {
          title,
          guidance,
        },
      });
    } finally {
      piScanInFlightRef.current = false;
    }
  }, [scanState.phase, beginNewScan, applyMeasurementResult]);

  const applyAgentReply = useCallback((data: Record<string, unknown>) => {
    const workflows =
      (data.workflows as WarehouseGraphResult[] | undefined) ?? [];
    const toolCalls = (data.toolCalls as string[] | undefined) ?? [];
    if (workflows.length > 0) setWorkflow(workflows[workflows.length - 1]);
    if (typeof data.traceId === "string") setTraceId(data.traceId);
    setTurns((previous) => [
      ...previous,
      {
        id: nextTurnId(),
        role: "agent",
        text: (data.message as string) ?? "",
        tools: toolCalls,
      },
    ]);
    if (data.status === "APPROVAL_REQUIRED") {
      setApproval(data.approval as PendingApprovalView);
      setOutcome(null);
    } else {
      setApproval(null);
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      lastOperatorMessage.current = message;
      setWorkflow(null);
      setTurns((previous) => [
        ...previous,
        { id: nextTurnId(), role: "operator", text: message },
      ]);
      setAgentBusy(true);
      setAgentError(null);
      setAgentUnavailable(false);

      const scanResult = scanState.scan?.scanResult ?? null;
      const scanImageDataUrl = scanState.scan
        ? (shots.find((shot) => shot.id === scanState.scan?.shotId)?.dataUrl ??
          null)
        : null;
      try {
        const { ok, data } = await postJson("/api/agent", {
          message,
          // Which conversation this turn belongs to — an opaque handle, and the
          // only conversational thing this client sends. The transcript itself
          // lives server-side; the browser never restates a turn or a tool
          // result, so it cannot tell the agent something happened that did not.
          sessionId: agentSessionId(),
          // Structured, out-of-band, exactly as the Milestone 5 contract
          // defines it — never pasted into the message text.
          ...(scanResult ? { scanResult } : {}),
          ...(scanResult && scanImageDataUrl ? { scanImageDataUrl } : {}),
          ...(confirmed ? { catalogResolutionId: confirmed.resolutionId } : {}),
        });

        if (!ok) {
          const failure = (data.error ?? {}) as {
            code?: string;
            message?: string;
          };
          if (failure.code === "agent_model_unavailable") {
            setAgentUnavailable(true);
          } else {
            setAgentError(
              failure.message ?? "The warehouse agent could not answer that.",
            );
          }
          return;
        }

        applyAgentReply(data);
      } catch {
        setAgentError("The warehouse agent could not be reached.");
      } finally {
        setAgentBusy(false);
        // Read-only turns change nothing, but a turn that ended in an executed
        // action does — and the client cannot tell which from here, so it
        // always re-reads the authoritative snapshot.
        void refresh();
        void refreshTraces();
      }
    },
    [applyAgentReply, confirmed, refresh, refreshTraces, scanState.scan, shots],
  );

  const decide = useCallback(
    async (decision: "APPROVE" | "DENY") => {
      if (!approval) return;
      const summary = approval.summary;
      setApproval(null);
      setAgentBusy(true);
      setActionInFlight(decision === "APPROVE");
      setOutcome(
        decision === "APPROVE"
          ? { kind: "EXECUTING", summary, message: "Executing…" }
          : {
              kind: "DECIDING",
              summary,
              message: "Cancelling the pending operation…",
            },
      );

      try {
        const { ok, data } = await postJson("/api/agent/approve", {
          // An id and a decision. No tool arguments: those were frozen
          // server-side when the agent paused, and this card has no way to
          // restate them.
          approvalId: approval.approvalId,
          decision,
        });

        if (!ok) {
          const expired = data.status === "APPROVAL_EXPIRED";
          setOutcome({
            kind: expired ? "EXPIRED" : "REJECTED",
            summary,
            message: expired
              ? "This approval was not answered in time and nothing was performed. Submit the warehouse action again if it is still required."
              : ((data.message as string) ??
                "That approval is no longer valid. Start a new request to act again."),
          });
          return;
        }

        const workflows =
          (data.workflows as WarehouseGraphResult[] | undefined) ?? [];
        if (workflows.length > 0) setWorkflow(workflows[workflows.length - 1]);
        // The SAME trace the pause belongs to — a decision continues the
        // timeline rather than starting a second one.
        if (typeof data.traceId === "string") setTraceId(data.traceId);

        setTurns((previous) => [
          ...previous,
          {
            id: nextTurnId(),
            role: "agent",
            text: (data.message as string) ?? "",
            tools: (data.toolCalls as string[]) ?? [],
          },
        ]);

        if (data.status === "APPROVAL_REQUIRED") {
          // The agent needs a further action. Nothing has executed for it yet.
          setApproval(data.approval as PendingApprovalView);
          setOutcome(null);
          return;
        }

        setOutcome({
          kind: decision === "APPROVE" ? "SETTLED" : "CANCELLED",
          summary,
          message: (data.message as string) ?? "",
        });
      } catch {
        setOutcome({
          kind: "REJECTED",
          summary,
          message:
            "The decision could not be submitted, so nothing was authorised. Check the warehouse state below before trying again.",
        });
      } finally {
        setAgentBusy(false);
        // The Movement table, not the button, says what actually happened.
        await refresh();
        void refreshTraces();
        setActionInFlight(false);
      }
    },
    [approval, refresh, refreshTraces],
  );

  const selectCandidate = useCallback(
    async (partId: string) => {
      if (!identification) return;
      setIdentityBusy(true);
      setIdentityError(null);
      try {
        const { ok, data } = await postJson(
          `/api/warehouse/catalog/resolutions/${identification.resolutionId}`,
          { decision: "CONFIRM", partId },
        );
        if (!ok || data.ok !== true) {
          // The server refused — an unlisted candidate, an expired decision,
          // or one already settled. The card stays open and says so.
          setIdentityError(
            (data.message as string) ??
              "That identification could not be recorded.",
          );
          return;
        }
        const candidate = identification.candidates.find(
          (item) => item.partId === partId,
        );
        setConfirmed({
          resolutionId: identification.resolutionId,
          scanId: identification.scanId,
          partId,
          sku: candidate?.sku ?? partId,
          canonicalName: candidate?.canonicalName ?? "",
        });
        setIdentification(null);
      } catch {
        setIdentityError("The identification could not be submitted.");
      } finally {
        setIdentityBusy(false);
      }
    },
    [identification],
  );

  const rejectIdentification = useCallback(async () => {
    if (!identification) return;
    setIdentityBusy(true);
    setIdentityError(null);
    try {
      const { ok, data } = await postJson(
        `/api/warehouse/catalog/resolutions/${identification.resolutionId}`,
        { decision: "REJECT" },
      );
      if (!ok || data.ok !== true) {
        setIdentityError(
          (data.message as string) ?? "That decision could not be recorded.",
        );
        return;
      }
      setIdentification(null);
      setIdentityRejected(true);
    } catch {
      setIdentityError("The decision could not be submitted.");
    } finally {
      setIdentityBusy(false);
    }
  }, [identification]);

  const reconsiderIdentification = useCallback(async () => {
    const scanResult = scanState.scan?.scanResult;
    if (!scanResult || !confirmed) return;

    // Never rewrite the earlier CONFIRMED decision: it remains valid audit
    // history. A new pending resolution is opened, and only once that succeeds
    // does the browser retire the old choice for this not-yet-started putaway.
    if (await requestIdentification(scanResult)) {
      setConfirmed(null);
      setIdentityRejected(false);
      setRegisterError(null);
    }
  }, [confirmed, requestIdentification, scanState.scan?.scanResult]);

  /**
   * Registers the current NO_MATCH scan as a brand-new catalog Part, then
   * re-runs the SAME /catalog/match call handleCapture uses — the new part
   * was built from this scan's own name/dimensions, so the standard matcher
   * is what turns this scan's identity into MATCHED, not this function.
   */
  const registerNewPart = useCallback(async () => {
    const scanResult = scanState.scan?.scanResult;
    if (!scanResult) return;
    setRegisteringPart(true);
    setRegisterError(null);
    try {
      // Same lookup guided-putaway-dialog's start() uses: the shot behind
      // this scan becomes the new part's representative photo.
      const shot = shots.find((s) => s.id === scanState.scan!.shotId);
      const { ok, data } = await postJson("/api/warehouse/catalog/register", {
        scanResult,
        ...(shot ? { imageDataUrl: shot.dataUrl } : {}),
      });
      if (!ok) {
        setRegisterError(
          (data.error as { message?: string } | undefined)?.message ??
            "Registration failed.",
        );
        return;
      }
      const { ok: matchOk, data: matchData } = await postJson(
        "/api/warehouse/catalog/match",
        {
          scanResult,
        },
      );
      if (!matchOk) {
        setRegisterError(
          "The part was registered, but the catalog could not be re-checked. Scan again to continue.",
        );
        return;
      }
      const match = matchData as unknown as CatalogMatchResult;
      setScanState((previous) =>
        previous.scan?.shotId === scanState.scan?.shotId
          ? { ...previous, scan: { ...previous.scan!, match } }
          : previous,
      );
    } catch {
      setRegisterError("The warehouse could not be reached. Try again.");
    } finally {
      setRegisteringPart(false);
    }
  }, [scanState.scan, shots]);

  const identity = scanState.scan
    ? deriveScanIdentity({
        hasValidScan: scanState.scan.scanResult !== null,
        matchStatus: scanState.scan.match?.status ?? null,
        humanConfirmed:
          confirmed !== null &&
          confirmed.scanId === scanState.scan.scanResult?.scanId,
      })
    : null;

  const value = useMemo<WarehouseSession>(() => {
    // Derived INSIDE the memo: `overview?.bins ?? []` builds a fresh array on
    // every render, so reading them outside would defeat the memo entirely.
    const bins = overview?.bins ?? [];
    const inventory = overview?.inventory ?? [];
    const movements = overview?.movements ?? [];

    return {
      bins,
      inventory,
      movements,
      latestAudit: overview?.latestAudit ?? null,
      activeMovement:
        movements.find((movement) =>
          [
            "RUNNING",
            "PRESENTING",
            "AWAITING_PLACEMENT",
            "RETURNING",
            "READY_TO_COMMIT",
            "READY_TO_CANCEL",
          ].includes(movement.status),
        ) ?? null,
      totals: overview?.totals ?? null,
      loading,
      overviewError,
      refresh,

      gantry,
      gantryError,

      shots,
      scanState,
      scanning:
        scanState.phase === "MEASURING" || scanState.phase === "MATCHING",
      identity,
      onCapture: (shot) => void handleCapture(shot),
      onDeleteShot: handleDelete,
      onMeasured: handleMeasured,
      piCapture,

      startPiScan: () => void startPiScan(),
      identification,
      confirmed,
      identityRejected,
      identityBusy,
      identityError,
      guidedPutawayRequestVersion,
      selectCandidate: (partId) => void selectCandidate(partId),
      rejectIdentification: () => void rejectIdentification(),
      reconsiderIdentification: () => void reconsiderIdentification(),
      registerNewPart: () => void registerNewPart(),
      registeringPart,
      registerError,

      approval,
      outcome,
      decide: (decision) => void decide(decision),
      hasDecision:
        approval !== null ||
        outcome !== null ||
        identification !== null ||
        confirmed !== null ||
        identityRejected,

      turns,
      agentBusy,
      agentError,
      agentUnavailable,
      send: (message) => void send(message),
      retryLast: () => {
        if (lastOperatorMessage.current) void send(lastOperatorMessage.current);
      },

      workflow,
      trace,
      traceError,
      recentTraces,
      selectTrace: setTraceId,
    };
  }, [
    overview,
    loading,
    overviewError,
    refresh,
    gantry,
    gantryError,
    shots,
    scanState,
    identity,
    handleCapture,
    handleDelete,
    handleMeasured,
    piCapture,
    startPiScan,
    identification,
    confirmed,
    identityRejected,
    identityBusy,
    identityError,
    guidedPutawayRequestVersion,
    selectCandidate,
    rejectIdentification,
    reconsiderIdentification,
    registerNewPart,
    registeringPart,
    registerError,
    approval,
    outcome,
    decide,
    turns,
    agentBusy,
    agentError,
    agentUnavailable,
    send,
    workflow,
    trace,
    traceError,
    recentTraces,
  ]);

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
