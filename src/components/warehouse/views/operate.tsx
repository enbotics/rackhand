"use client";

import { CameraStage } from "@/components/camera-stage";
import { useSharedCamera } from "@/lib/camera-context";
import { PiCameraPanel } from "../pi-camera-panel";
import { CurrentScanPanel } from "../current-scan-panel";
import { GuidedPutawayDialog } from "../guided-putaway-dialog";
import { Panel } from "../ui";

import { useWarehouseSession } from "../session";

import { PageShell } from "./shell";

/**
 * SCAN — physical scan station.
 *
 * The Warehouse Agent conversation lives on the Warehouse page only (see
 * warehouse-view.tsx) — it is never duplicated here. This page keeps just
 * the scanner-adjacent physical surfaces: Raspberry Pi capture, the browser
 * camera fallback, and the guided putaway dialog (capture -> identify ->
 * confirmed-identity handoff). A completed scan becomes shared session
 * context the Warehouse Agent can act on from the other page; scanning itself
 * never takes over the landing page.
 *
 * The audit capture dialog is NOT here any more: an audit is usually started
 * from the chat on the landing page, so it mounts at the layout instead and
 * reads the same shared camera this stage does.
 */
export function OperateView() {
  const session = useWarehouseSession();
  const camera = useSharedCamera();

  return (
    <PageShell
      title="Stationary Scan"
      intent="Capture and identify a part before asking the Warehouse Agent to act on it."
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {/* Primary physical camera */}
        <PiCameraPanel
          capture={session.piCapture}
          scanning={session.scanning}
          onScan={session.startPiScan}
        />

        {/* Same measurement/catalog UI for browser and Pi scans */}
        <CurrentScanPanel
          state={session.scanState}
          identity={session.identity}
          confirmed={session.confirmed}
        />

        {/*
         * Keep browser camera until Step 12.
         *
         * It still supports:
         * - legacy browser scan
         * - guided putaway verification
         * - old audit capture flow
         */}
        <Panel title="Browser Camera — Fallback" className="flex-1">
          <CameraStage onCapture={session.onCapture} scanning={session.scanning} />
        </Panel>

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
          onCaptureVerification={camera.captureFrame}
          getCameraStream={camera.getStream}
          onWarehouseChanged={session.refresh}
        />
      </div>
    </PageShell>
  );
}
