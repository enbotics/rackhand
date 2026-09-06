"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraStage } from "@/components/camera-stage";
import { Gallery } from "@/components/gallery";
import {
  addShot,
  deleteShot,
  getAllShots,
  setShotMeasurement,
  type Measurement,
  type Shot,
} from "@/lib/shots-db";
import { measurementToScanResult } from "@/lib/warehouse/scan-result";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import type { CatalogMatchResult } from "@/lib/warehouse/catalog-match-types";
import type { CatalogResolutionRequestResult } from "@/lib/warehouse/catalog-resolution-types";
import {
  deriveScanIdentity,
  describeMeasureFailure,
} from "@/lib/warehouse/dashboard-presentation";
import {
  useAgentTrace,
  useGantryStatus,
  useRecentTraces,
  useWarehouseOverview,
} from "@/lib/use-warehouse-data";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import { AgentPanel } from "./agent-panel";
import { ApprovalCard } from "./approval-card";
import { CatalogResolutionCard } from "./catalog-resolution-card";
import { CurrentScanPanel } from "./current-scan-panel";
import { GantryStatusPanel } from "./gantry-status";
import { InventoryPanel } from "./inventory-panel";
import { MovementHistory } from "./movement-history";
import { WorkflowPanel } from "./workflow-panel";
import { AgentActivityPanel } from "./agent-activity";
import { EmptyState, Panel } from "./ui";
import { WarehouseMap } from "./warehouse-map";
import type {
  AgentTurn,
  ApprovalOutcome,
  ConfirmedIdentity,
  CurrentScan,
  PendingApprovalView,
  PendingIdentification,
  ScanState,
} from "./state";

/**
 * The Warehouse Command Center — the one operator screen (Milestone 10).
 *
 * WHAT THIS COMPONENT IS: a coordinator. It sequences existing server calls,
 * holds the operator's session state, and re-reads the authoritative warehouse
 * snapshot after anything changes.
 *
 * WHAT IT IS NOT: an owner of warehouse rules. There is no matching, no
 * availability check, no quantity arithmetic and no approval decision here.
 * Every one of those already exists behind an API from Milestones 1-9, and a
 * second copy in the browser would eventually disagree with the first. In
 * particular this component NEVER writes to bins, inventory or movements: the
 * only state-changing calls it can make are /api/agent (which stops for
 * approval) and /api/agent/approve (which sends an id and a decision, nothing
 * else).
 *
 * The scanning pipeline is unchanged: capture -> /api/measure ->
 * measurementToScanResult -> /api/warehouse/catalog/match. Scanning never
 * triggers a physical action; a putaway still has to be asked for and then
 * approved.
 */

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data: data as Record<string, unknown> };
}

let turnCounter = 0;
function nextTurnId(): string {
  turnCounter += 1;
  return `turn_${turnCounter}`;
}

const EMPTY_SCAN: ScanState = { phase: "EMPTY", scan: null, failure: null };

export function CommandCenter() {
  // Local scan history (IndexedDB). Never warehouse authority.
  const [shots, setShots] = useState<Shot[]>([]);

  // Current scan session.
  const [scanState, setScanState] = useState<ScanState>(EMPTY_SCAN);
  const [identification, setIdentification] = useState<PendingIdentification | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedIdentity | null>(null);
  const [identityRejected, setIdentityRejected] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

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
  const { overview, loading, error: overviewError, refresh } = useWarehouseOverview();
  const { trace, error: traceError } = useAgentTrace(traceId);
  const { traces: recentTraces, refresh: refreshTraces } = useRecentTraces();
  const [actionInFlight, setActionInFlight] = useState(false);
  const { status: gantry, error: gantryError } = useGantryStatus(actionInFlight);

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
        previous.map((shot) => (shot.id === id ? { ...shot, measurement, scanResult } : shot)),
      );
    },
    [],
  );

  const requestIdentification = useCallback(async (scanResult: ScanResult) => {
    setIdentityBusy(true);
    setIdentityError(null);
    try {
      const { data } = await postJson("/api/warehouse/catalog/resolutions", { scanResult });
      const result = data as unknown as CatalogResolutionRequestResult;
      if (result.status === "HUMAN_DECISION_REQUIRED") {
        setIdentification({
          resolutionId: result.resolutionId,
          scanId: result.scanId,
          reason: result.reason,
          expiresAt: result.expiresAt,
          candidates: result.candidates,
        });
      }
      // MATCHED / NO_MATCH / RESCAN_REQUIRED need no card: the scan panel
      // already shows the matcher's verdict, and none of them is resolvable.
    } catch {
      setIdentityError("The identification service could not be reached.");
    } finally {
      setIdentityBusy(false);
    }
  }, []);

  /**
   * capture -> measure -> ScanResult -> catalog match.
   *
   * Ends there, deliberately. Scanning identifies a part; it never puts one
   * away. The physical action is a separate request that a person approves.
   */
  const handleCapture = useCallback(
    async (shot: Shot) => {
      setShots((previous) => [shot, ...previous]);
      addShot(shot).catch(() => {
        // local history failing must not stop the warehouse workflow
      });

      // A new scan retires every decision made about the previous one. An
      // identity confirmed for one scan may never travel to another.
      setIdentification(null);
      setConfirmed(null);
      setIdentityRejected(false);
      setIdentityError(null);
      setScanState({ phase: "MEASURING", scan: null, failure: null });

      let ok: boolean;
      let body: Record<string, unknown>;
      try {
        const response = await fetch("/api/measure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageDataUrl: shot.dataUrl,
            imageWidthPx: shot.width,
            imageHeightPx: shot.height,
          }),
        });
        ok = response.ok;
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        setScanState({
          phase: "FAILED",
          scan: null,
          failure: {
            title: "The measurement service could not be reached.",
            guidance: "Check that the application server is running, then scan again.",
          },
        });
        return;
      }

      if (!ok) {
        const failure = (body.error ?? {}) as { code?: unknown; message?: unknown };
        setScanState({
          phase: "FAILED",
          scan: null,
          failure: describeMeasureFailure(failure.code, failure.message),
        });
        return;
      }

      const measurement: Measurement = {
        name: body.name as string,
        description: body.description as string,
        lengthMM: body.lengthMM as number,
        widthMM: body.widthMM as number,
        heightMM: body.heightMM as number | null,
        angleDegrees: body.angleDegrees as number,
        dimensionConfidence: body.dimensionConfidence as number,
        calibrationRmsPixels: body.calibrationRmsPixels as number,
        measuredAt: Date.now(),
      };

      // The same conversion the lightbox uses. A measurement that fails it is
      // still shown, but it is not warehouse evidence and cannot be put away.
      const conversion = measurementToScanResult(measurement, { capturedAt: shot.createdAt });
      const scanResult = conversion.ok ? conversion.scanResult : null;

      setShotMeasurement(shot.id, measurement, scanResult ?? undefined).catch(() => {});
      setShots((previous) =>
        previous.map((item) =>
          item.id === shot.id
            ? { ...item, measurement, scanResult: scanResult ?? undefined }
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

      if (!scanResult) {
        setScanState({ phase: "READY", scan, failure: null });
        return;
      }

      setScanState({ phase: "MATCHING", scan, failure: null });

      try {
        const { ok: matchOk, data } = await postJson("/api/warehouse/catalog/match", { scanResult });
        if (!matchOk) throw new Error("match failed");
        const match = data as unknown as CatalogMatchResult;
        setScanState({ phase: "READY", scan: { ...scan, match }, failure: null });
        if (match.status === "AMBIGUOUS") {
          await requestIdentification(scanResult);
        }
      } catch {
        setScanState({
          phase: "READY",
          scan: { ...scan, matchError: "unavailable" },
          failure: null,
        });
      }
    },
    [requestIdentification],
  );

  const applyAgentReply = useCallback(
    (data: Record<string, unknown>) => {
      const workflows = (data.workflows as WarehouseGraphResult[] | undefined) ?? [];
      if (workflows.length > 0) setWorkflow(workflows[workflows.length - 1]);
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
        setApproval(data.approval as PendingApprovalView);
        setOutcome(null);
      } else {
        setApproval(null);
      }
    },
    [],
  );

  const send = useCallback(
    async (message: string) => {
      lastOperatorMessage.current = message;
      setWorkflow(null);
      setTurns((previous) => [...previous, { id: nextTurnId(), role: "operator", text: message }]);
      setAgentBusy(true);
      setAgentError(null);
      setAgentUnavailable(false);

      const scanResult = scanState.scan?.scanResult ?? null;
      try {
        const { ok, data } = await postJson("/api/agent", {
          message,
          // Structured, out-of-band, exactly as the Milestone 5 contract
          // defines it — never pasted into the message text.
          ...(scanResult ? { scanResult } : {}),
          ...(confirmed ? { catalogResolutionId: confirmed.resolutionId } : {}),
        });

        if (!ok) {
          const failure = (data.error ?? {}) as { code?: string; message?: string };
          if (failure.code === "agent_model_unavailable") {
            setAgentUnavailable(true);
          } else {
            setAgentError(failure.message ?? "The warehouse agent could not answer that.");
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
    [applyAgentReply, confirmed, refresh, refreshTraces, scanState.scan],
  );

  const decide = useCallback(
    async (decision: "APPROVE" | "DENY") => {
      if (!approval) return;
      const summary = approval.summary;
      setApproval(null);
      setAgentBusy(true);
      setActionInFlight(true);
      setOutcome({
        kind: "EXECUTING",
        summary,
        message: "Executing…",
      });

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

        const workflows = (data.workflows as WarehouseGraphResult[] | undefined) ?? [];
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
            (data.message as string) ?? "That identification could not be recorded.",
          );
          return;
        }
        const candidate = identification.candidates.find((item) => item.partId === partId);
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
        setIdentityError((data.message as string) ?? "That decision could not be recorded.");
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

  const identity = scanState.scan
    ? deriveScanIdentity({
        hasValidScan: scanState.scan.scanResult !== null,
        matchStatus: scanState.scan.match?.status ?? null,
        humanConfirmed:
          confirmed !== null && confirmed.scanId === scanState.scan.scanResult?.scanId,
      })
    : null;

  const bins = overview?.bins ?? [];
  const inventory = overview?.inventory ?? [];
  const movements = overview?.movements ?? [];
  const activeMovement = movements.find((movement) => movement.status === "RUNNING") ?? null;
  const scanning = scanState.phase === "MEASURING" || scanState.phase === "MATCHING";
  const hasDecision = approval !== null || outcome !== null || identification !== null ||
    confirmed !== null || identityRejected;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6 lg:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Agentic Spare Parts Warehouse
          </h1>
          <p className="mt-1 text-xs text-ink-muted">
            AI-assisted inventory, putaway and retrieval
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 font-mono text-[11px]">
          <span className="text-ink-faint">
            Stock <span className="text-ink-muted">{overview?.totals.units ?? "—"}</span> units ·{" "}
            <span className="text-ink-muted">{overview?.totals.distinctParts ?? "—"}</span> parts
          </span>
          <span className="text-ink-faint">
            Bins{" "}
            <span className="text-ink-muted">
              {overview ? `${overview.totals.binsAvailable} available` : "—"}
            </span>
          </span>
          <span className="inline-flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-1 font-medium tracking-[0.1em] text-warn">
            <span aria-hidden="true">●</span>
            GANTRY MODE: {gantry?.mode ?? "SIMULATION"}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Panel title="Live camera">
            <CameraStage onCapture={handleCapture} scanning={scanning} />
          </Panel>

          <CurrentScanPanel state={scanState} identity={identity} confirmed={confirmed} />

          <WarehouseMap
            bins={bins}
            loading={loading}
            error={overviewError}
            onRetry={() => void refresh()}
            activeLocation={gantry?.state !== "IDLE" ? gantry?.currentLocation : null}
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <AgentPanel
            turns={turns}
            busy={agentBusy}
            unavailable={agentUnavailable}
            error={agentError}
            scanAttached={scanState.scan?.scanResult != null}
            identityAttached={confirmed !== null}
            onSend={send}
            onRetry={() => {
              if (lastOperatorMessage.current) void send(lastOperatorMessage.current);
            }}
          />

          {hasDecision ? (
            <>
              <ApprovalCard
                approval={approval}
                outcome={outcome}
                busy={agentBusy}
                latestMovement={movements[0] ?? null}
                onDecide={(decision) => void decide(decision)}
              />
              <CatalogResolutionCard
                identification={identification}
                confirmed={confirmed}
                rejected={identityRejected}
                busy={identityBusy}
                error={identityError}
                onSelect={(partId) => void selectCandidate(partId)}
                onReject={() => void rejectIdentification()}
              />
            </>
          ) : (
            <Panel title="Human decisions">
              <EmptyState>
                Nothing is waiting on you.
                <br />
                Approvals and identity decisions appear here.
              </EmptyState>
            </Panel>
          )}

          <WorkflowPanel workflow={workflow} />

          <AgentActivityPanel
            trace={trace}
            error={traceError}
            recent={recentTraces}
            onSelectTrace={setTraceId}
          />

          <InventoryPanel
            inventory={inventory}
            loading={loading}
            error={overviewError}
            onRetry={() => void refresh()}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <GantryStatusPanel status={gantry} error={gantryError} activeMovement={activeMovement} />
        </div>
        <div className="lg:col-span-8">
          <MovementHistory
            movements={movements}
            loading={loading}
            error={overviewError}
            onRetry={() => void refresh()}
          />
        </div>
      </div>

      <Gallery shots={shots} onDelete={handleDelete} onMeasured={handleMeasured} />

      <footer className="border-t border-line-soft pt-4 text-[11px] leading-relaxed text-ink-faint">
        Warehouse state — bins, inventory and movements — is read from the warehouse database on
        every refresh. Captured frames stay in this browser (IndexedDB) as local scan history and
        are never treated as inventory.
      </footer>
    </div>
  );
}
