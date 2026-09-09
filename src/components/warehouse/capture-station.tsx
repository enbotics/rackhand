"use client";

import { useAuditCapture } from "./audit-capture-dialog";
import { useState } from "react";
import { useWarehouseSession } from "./session";
import { useSharedCamera } from "@/lib/camera-context";
import { GuidedPutawayDialog } from "./guided-putaway-dialog";
import { BUTTON_VARIANTS } from "./ui";
import { CapturePopup } from "./capture-popup";

/** Camera controls live in a popup; the main page stays focused on the rack. */
export function CaptureStation() {
  const session = useWarehouseSession();
  const audit = useAuditCapture();
  const [open, setOpen] = useState(false);
  const machineBusy = !!session.gantry?.activeOperationId;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        disabled={session.scanning || audit.pending !== null || audit.submitting}
        className={BUTTON_VARIANTS.approve}>
        {session.scanning || audit.submitting ? "Scanning…" : "Register an item"}
      </button>
      {open && !session.scanning && !audit.pending && <CapturePopup title="Register an item"
        onClose={() => setOpen(false)} disabled={machineBusy}
        onCapture={(shot) => { setOpen(false); session.onCapture(shot); }} />}
    </>
  );
}

/** Existing identification/catalog logic; only its presentation timing changes. */
export function ScanResultDialog() {
  const session = useWarehouseSession();
  const camera = useSharedCamera();
  return <GuidedPutawayDialog
    scanState={session.scanState} identity={session.identity} confirmed={session.confirmed}
    identification={session.identification} identityRejected={session.identityRejected}
    identityBusy={session.identityBusy} identityError={session.identityError}
    openRequestVersion={session.guidedPutawayRequestVersion} bins={session.bins}
    gantry={session.gantry} shots={session.shots} onSelectIdentity={session.selectCandidate}
    onRejectIdentity={session.rejectIdentification} onReconsiderIdentity={session.reconsiderIdentification}
    onRegisterNewPart={session.registerNewPart} registeringPart={session.registeringPart}
    registerError={session.registerError} onCaptureVerification={camera.captureFrame}
    getCameraStream={camera.getStream} onWarehouseChanged={session.refresh}
  />;
}
