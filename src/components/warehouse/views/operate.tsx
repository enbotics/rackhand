"use client";

import { PiCameraPanel } from "../pi-camera-panel";
import { CurrentScanPanel } from "../current-scan-panel";
import { GuidedPutawayDialog } from "../guided-putaway-dialog";

import { useWarehouseSession } from "../session";

import { PageShell } from "./shell";

/**
 * SCAN — physical scan station.
 *
 * The Warehouse Agent conversation lives on the Warehouse page only (see
 * warehouse-view.tsx) — it is never duplicated here. This page keeps just
 * the scanner-adjacent physical surfaces: Raspberry Pi capture and the
 * guided putaway dialog (capture -> identify ->
 * confirmed-identity handoff). A completed scan becomes shared session
 * context the Warehouse Agent can act on from the other page; scanning itself
 * never takes over the landing page.
 *
 * The audit capture dialog is NOT here any more: an audit is usually started
 * from the chat on the landing page, so it mounts at the layout instead and
 * uses the same Raspberry Pi capture-job service.
 */
export function OperateView() {
  const session = useWarehouseSession();

  return (
    <PageShell
      title="Stationary Scan"
      intent="Capture and identify a part before asking the RackHand Agent to act on it."
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {/* Primary physical camera */}
        <PiCameraPanel
          capture={session.piCapture}
          scanning={session.scanning}
          onScan={session.startPiScan}
        />

        {/* Measurement and catalog result from the Raspberry Pi capture */}
        <CurrentScanPanel
          state={session.scanState}
          identity={session.identity}
          confirmed={session.confirmed}
        />

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
          onReconsiderIdentity={session.reconsiderIdentification}
          onRegisterNewPart={session.registerNewPart}
          registeringPart={session.registeringPart}
          registerError={session.registerError}
          onWarehouseChanged={session.refresh}
        />
      </div>
    </PageShell>
  );
}
