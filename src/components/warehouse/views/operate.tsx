"use client";

import { CameraStage } from "@/components/camera-stage";
import { useSharedCamera } from "@/lib/camera-context";
import { GuidedPutawayDialog } from "../guided-putaway-dialog";
import { Panel } from "../ui";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * SCAN — the dedicated physical camera station.
 *
 * The Warehouse Agent conversation lives on the Warehouse page only (see
 * warehouse-view.tsx) — it is never duplicated here. This page keeps just
 * the scanner-adjacent physical surfaces: the live camera, the guided
 * putaway dialog (capture -> identify -> confirmed-identity handoff). A
 * completed scan becomes shared session context the Warehouse Agent can act
 * on from the other page; scanning itself never takes over the landing page.
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
        <Panel title="Stationary Scan" className="flex-1">
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
