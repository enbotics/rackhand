"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { InventoryPanel } from "../inventory-panel";
import { WarehouseRack } from "../warehouse-rack";
import { ManageBinsModal } from "../admin/manage-bins-modal";
import { BinDetailModal } from "../bin-detail-modal";
import { AgentPanel } from "../agent-panel";
import { AgentActivityPanel } from "../agent-activity";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * WORKSPACE — a viewport-sized rack beside agent, inventory and activity tabs.
 *
 * Identification choices,
 * HITL approval, workflow/gantry progress and audit results are not separate
 * panels here — they are trailing cards inside AgentPanel's own scrollable
 * transcript (see that file). There is deliberately no standalone "Human
 * decisions", "Approval", "Workflow", "Inventory audit" or "Gantry status"
 * control panel on this page: those are states within the conversation. The
 * Activity tab is read-only and shows the short observable execution trail.
 */
export function WarehouseView() {
  const session = useWarehouseSession();
  const [tab, setTab] = useState<"agent" | "inventory" | "activity">("agent");
  const tabId = useId();
  const agentTab = useRef<HTMLButtonElement>(null);
  const inventoryTab = useRef<HTMLButtonElement>(null);
  const activityTab = useRef<HTMLButtonElement>(null);
  const waiting = (session.approval ? 1 : 0) + (session.identification ? 1 : 0);
  const [managingBins, setManagingBins] = useState(false);
  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  // Looked up fresh on every render, not captured at click-time, so an edit
  // made inside the modal (which calls onWarehouseChanged -> session.refresh)
  // shows up in the same modal instantly rather than needing a re-open.
  const selectedBin = session.bins.find((bin) => bin.binId === selectedBinId) ?? null;

  // Stable identities: the rack's shelf is memoised, and a fresh closure on
  // every gantry poll would defeat that.
  const openBinManager = useCallback(() => setManagingBins(true), []);
  const selectBin = useCallback((bin: BinView) => setSelectedBinId(bin.binId), []);

  // The settled outcome's movement status chip needs the real row, not the
  // button that was pressed — same lookup the old AgentWorkspace used.
  const workflowMovementId =
    session.workflow && "movementId" in session.workflow ? session.workflow.movementId : null;
  const outcomeMovement = workflowMovementId
    ? session.movements.find((movement) => movement.id === workflowMovementId) ?? null
    : null;

  return (
    <PageShell
      viewport
      showHeader={false}
      title="Workspace"
      intent="Watch the gantry, capture a part, and work with your RackHand Agent."
    >
      <div className="warehouse-workspace-grid grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex min-h-0 min-w-0 flex-col lg:col-span-7">
          {/*
            The single live picture of the machine. It is given the controller
            status AND the semantic trip (the active movement, or the running
            audit) because neither alone says both where the head is and what
            the trip is for — see warehouse-rack.tsx.
          */}
          <WarehouseRack
            bins={session.bins}
            loading={session.loading}
            error={session.overviewError}
            onRetry={session.refresh}
            gantry={session.gantry}
            activeMovement={session.activeMovement}
            latestAudit={session.latestAudit}
            onManageBins={openBinManager}
            onSelectBin={selectBin}
          />
        </div>

        <div className="warehouse-sidebar flex min-h-0 min-w-0 flex-col gap-3 lg:col-span-5">
          <div role="tablist" aria-label="Workspace panels" className="relative grid shrink-0 grid-cols-3 rounded-xl border border-line bg-bg-elevated p-1"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const tabs = ["agent", "inventory", "activity"] as const;
              const current = tabs.indexOf(tab);
              const next = event.key === "Home"
                ? "agent"
                : event.key === "End"
                  ? "activity"
                  : tabs[(current + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
              setTab(next);
              (next === "agent" ? agentTab : next === "inventory" ? inventoryTab : activityTab).current?.focus();
            }}>
            <span aria-hidden="true" className="workspace-tab-indicator" style={{ transform: `translateX(${tab === "agent" ? "0" : tab === "inventory" ? "100%" : "200%"})` }} />
            <button ref={agentTab} type="button" role="tab" id={`${tabId}-agent-tab`} aria-controls={`${tabId}-agent-panel`}
              aria-selected={tab === "agent"} tabIndex={tab === "agent" ? 0 : -1} onClick={() => setTab("agent")}
              className="relative z-10 flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-accent">
              RackHand Agent
              {waiting > 0 && <span className="rounded-full bg-warn px-1.5 text-[10px] text-bg" aria-label={`${waiting} decisions waiting`}>{waiting}</span>}
              {session.agentBusy && <span className="h-1.5 w-1.5 rounded-full bg-accent animate-glow-pulse" aria-label="Agent working" />}
              {(session.todayPlanAnalysis?.status === "QUEUED" || session.todayPlanAnalysis?.status === "RUNNING") && (
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-glow-pulse" aria-label="Today’s plan analysis running" />
              )}
            </button>
            <button ref={inventoryTab} type="button" role="tab" id={`${tabId}-inventory-tab`} aria-controls={`${tabId}-inventory-panel`}
              aria-selected={tab === "inventory"} tabIndex={tab === "inventory" ? 0 : -1} onClick={() => setTab("inventory")}
              className="relative z-10 rounded-lg px-3 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-accent">
              Inventory <span className="ml-1 text-ink-faint">{session.inventory.length}</span>
            </button>
            <button ref={activityTab} type="button" role="tab" id={`${tabId}-activity-tab`} aria-controls={`${tabId}-activity-panel`}
              aria-selected={tab === "activity"} tabIndex={tab === "activity" ? 0 : -1} onClick={() => setTab("activity")}
              className="relative z-10 rounded-lg px-3 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-accent">
              Activity
            </button>
          </div>
          <div className="workspace-tab-panel min-h-0 flex-1" role="tabpanel" id={`${tabId}-agent-panel`} aria-labelledby={`${tabId}-agent-tab`} hidden={tab !== "agent"}>
          <AgentPanel
            active={tab === "agent"}
            turns={session.turns}
            busy={session.agentBusy}
            unavailable={session.agentUnavailable}
            error={session.agentError}
            liveToolName={session.liveToolName}
            scanAttached={session.scanState.scan?.scanResult != null}
            identityAttached={session.confirmed !== null}
            onSend={session.send}
            onRetry={session.retryLast}
            identification={session.identification}
            confirmed={session.confirmed}
            identityRejected={session.identityRejected}
            identityBusy={session.identityBusy}
            identityError={session.identityError}
            onSelectIdentity={session.selectCandidate}
            onRejectIdentity={session.rejectIdentification}
            onRegisterNewPart={session.registerNewPart}
            registeringPart={session.registeringPart}
            registerError={session.registerError}
            detectedName={session.scanState.scan?.measurement?.name ?? null}
            approval={session.approval}
            outcome={session.outcome}
            onDecide={session.decide}
            gantry={session.gantry}
            latestMovement={outcomeMovement}
            workflow={session.workflow}
            materialsPlan={session.materialsPlan}
            materialsPlanCheck={session.materialsPlanCheck}
            onDismissMaterialsPlan={session.dismissMaterialsPlan}
            todayPlanAnalysis={session.todayPlanAnalysis}
            latestAudit={session.latestAudit}
            onAuditChanged={session.refresh}
          />
          </div>
          <div className="workspace-tab-panel min-h-0 flex-1" role="tabpanel" id={`${tabId}-inventory-panel`} aria-labelledby={`${tabId}-inventory-tab`} hidden={tab !== "inventory"}>
            <InventoryPanel inventory={session.inventory} loading={session.loading}
              error={session.overviewError} onRetry={session.refresh} contained />
          </div>
          <div className="workspace-tab-panel min-h-0 flex-1" role="tabpanel" id={`${tabId}-activity-panel`} aria-labelledby={`${tabId}-activity-tab`} hidden={tab !== "activity"}>
            <AgentActivityPanel
              trace={session.trace}
              error={session.traceError}
              recent={session.recentTraces}
              onSelectTrace={session.selectTrace}
            />
          </div>
        </div>
      </div>

      {managingBins && (
        <ManageBinsModal
          bins={session.bins}
          onClose={() => setManagingBins(false)}
          onChanged={session.refresh}
        />
      )}

      {selectedBin && (
        <BinDetailModal
          bin={selectedBin}
          onClose={() => setSelectedBinId(null)}
          onChanged={session.refresh}
        />
      )}
    </PageShell>
  );
}
