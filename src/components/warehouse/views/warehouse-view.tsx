"use client";

import { useState } from "react";
import { InventoryPanel } from "../inventory-panel";
import { WarehouseMap } from "../warehouse-map";
import { ManageBinsModal } from "../admin/manage-bins-modal";
import { BinDetailModal } from "../bin-detail-modal";
import { AgentPanel } from "../agent-panel";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * WAREHOUSE — the landing page. Bins and inventory on the left; the
 * Warehouse Agent conversation, in full, on the right.
 *
 * The chat is the ONLY thing on the right column. Identification choices,
 * HITL approval, workflow/gantry progress and audit results are not separate
 * panels here — they are trailing cards inside AgentPanel's own scrollable
 * transcript (see that file). There is deliberately no standalone "Human
 * decisions", "Approval", "Workflow", "Inventory audit" or "Gantry status"
 * panel on this page: those are states within the conversation, not
 * dashboard widgets beside it.
 */
export function WarehouseView() {
  const session = useWarehouseSession();
  const [managingBins, setManagingBins] = useState(false);
  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  // Looked up fresh on every render, not captured at click-time, so an edit
  // made inside the modal (which calls onWarehouseChanged -> session.refresh)
  // shows up in the same modal instantly rather than needing a re-open.
  const selectedBin = session.bins.find((bin) => bin.binId === selectedBinId) ?? null;

  // The settled outcome's movement status chip needs the real row, not the
  // button that was pressed — same lookup the old AgentWorkspace used.
  const workflowMovementId =
    session.workflow && "movementId" in session.workflow ? session.workflow.movementId : null;
  const outcomeMovement = workflowMovementId
    ? session.movements.find((movement) => movement.id === workflowMovementId) ?? null
    : null;

  return (
    <PageShell
      title="Warehouse"
      intent="Authoritative state: what each bin holds, what is in stock, and what the machine is doing."
      footer="Read from the warehouse database and the gantry controller. Bin status is stored, never inferred from whether a bin happens to hold stock."
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12 xl:items-stretch">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <WarehouseMap
            bins={session.bins}
            loading={session.loading}
            error={session.overviewError}
            onRetry={session.refresh}
            activeLocation={
              session.gantry?.state !== "IDLE" ? session.gantry?.currentLocation : null
            }
            onManageBins={() => setManagingBins(true)}
            onSelectBin={(bin) => setSelectedBinId(bin.binId)}
          />
          <InventoryPanel
            inventory={session.inventory}
            loading={session.loading}
            error={session.overviewError}
            onRetry={session.refresh}
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4 xl:col-span-5">
          <AgentPanel
            turns={session.turns}
            busy={session.agentBusy}
            unavailable={session.agentUnavailable}
            error={session.agentError}
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
            latestAudit={session.latestAudit}
          />
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
