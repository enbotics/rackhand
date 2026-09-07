"use client";

import { CameraStage } from "@/components/camera-stage";
import { AgentPanel } from "../agent-panel";
import { ApprovalCard } from "../approval-card";
import { GuidedPutawayDialog } from "../guided-putaway-dialog";
import { CurrentScanPanel } from "../current-scan-panel";
import { WorkflowPanel } from "../workflow-panel";
import { EmptyState, Panel } from "../ui";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * OPERATE — the live loop, deliberately whole.
 *
 * Scan, identify, ask, approve — without leaving the page. Milestone 13
 * validated this sequence; splitting it across routes would have traded a
 * working demo for a tidier menu.
 *
 * The bin map lives on Warehouse alone, not here. What an operator needs at
 * this point is whether the action they authorised actually happened, and two
 * panels already say so from authoritative sources: the approval outcome names
 * the destination bin, read back from the Movement row rather than from the
 * button that was pressed, and the Workflow panel shows the graph's own
 * "stored in B1-03". The shelf itself is one click away.
 */
export function OperateView() {
  const session = useWarehouseSession();

  return (
    <PageShell
      title="Operate"
      intent="Scan a part, settle its identity, ask the agent, and approve what it wants to do."
      footer="Captured frames stay in this browser as local scan history and are never treated as inventory. Bins, stock and movements are read from the warehouse database on every refresh."
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Panel title="Live camera">
            <CameraStage onCapture={session.onCapture} scanning={session.scanning} />
          </Panel>

          {session.scanState.scan === null && (
            <CurrentScanPanel state={session.scanState} identity={null} confirmed={null} />
          )}

          <GuidedPutawayDialog
            scanState={session.scanState}
            identity={session.identity}
            confirmed={session.confirmed}
            identification={session.identification}
            identityRejected={session.identityRejected}
            identityBusy={session.identityBusy}
            identityError={session.identityError}
            openRequestVersion={session.guidedPutawayRequestVersion}
            bins={session.bins}
            gantry={session.gantry}
            shots={session.shots}
            onSelectIdentity={session.selectCandidate}
            onRejectIdentity={session.rejectIdentification}
            onRegisterNewPart={session.registerNewPart}
            registeringPart={session.registeringPart}
            registerError={session.registerError}
            onWarehouseChanged={session.refresh}
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <AgentPanel
            turns={session.turns}
            busy={session.agentBusy}
            unavailable={session.agentUnavailable}
            error={session.agentError}
            scanAttached={session.scanState.scan?.scanResult != null}
            identityAttached={session.confirmed !== null}
            onSend={session.send}
            onRetry={session.retryLast}
          />

          {session.approval || session.outcome ? (
            <ApprovalCard
              approval={session.approval}
              outcome={session.outcome}
              busy={session.agentBusy}
              latestMovement={session.movements[0] ?? null}
              onDecide={session.decide}
            />
          ) : (
            <Panel title="Human decisions">
              <EmptyState>
                Nothing is waiting on you.
                <br />
                Approvals and identity decisions appear here.
              </EmptyState>
            </Panel>
          )}

          <WorkflowPanel workflow={session.workflow} />
        </div>
      </div>
    </PageShell>
  );
}
