"use client";

import { useCallback, useRef } from "react";
import { CameraStage, type CameraStageHandle } from "@/components/camera-stage";
import { GuidedPutawayDialog } from "../guided-putaway-dialog";
import { AuditCaptureDialog } from "../audit-capture-dialog";
import { Panel } from "../ui";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * SCAN — the dedicated physical camera station.
 *
 * The Warehouse Agent conversation lives on the Warehouse page only (see
 * warehouse-view.tsx) — it is never duplicated here. This page keeps just
 * the scanner-adjacent physical surfaces: the live camera, the guided
 * putaway dialog (capture -> identify -> confirmed-identity handoff), and
 * the audit capture dialog. A completed scan becomes shared session context
 * the Warehouse Agent can act on from the other page; scanning itself never
 * takes over the landing page.
 */
export function OperateView() {
  const session = useWarehouseSession();
  const cameraRef = useRef<CameraStageHandle>(null);
  const captureFrame = useCallback(() => cameraRef.current?.captureFrame() ?? null, []);
  const getCameraStream = useCallback(() => cameraRef.current?.getStream() ?? null, []);

  return (
    <PageShell
      title="Stationary Scan"
      intent="Capture and identify a part before asking the Warehouse Agent to act on it."
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <Panel title="Stationary Scan" className="flex-1">
          <CameraStage
            ref={cameraRef}
            onCapture={session.onCapture}
            scanning={session.scanning}
          />
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
          onCaptureVerification={captureFrame}
          getCameraStream={getCameraStream}
          onWarehouseChanged={session.refresh}
        />
      </div>

      <AuditCaptureDialog captureFrame={captureFrame} getCameraStream={getCameraStream} />
    </PageShell>
  );
}
