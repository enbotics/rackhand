"use client";

import { useAuditCapture } from "./audit-capture-dialog";
import { useState } from "react";
import { useWarehouseSession } from "./session";
import { GuidedPutawayDialog } from "./guided-putaway-dialog";
import { BUTTON_VARIANTS } from "./ui";
import { CapturePopup } from "./capture-popup";

/** Pi capture controls live in a popup; the main page stays focused on the rack. */
export function CaptureStation({
  menuItem = false,
  onDialogClosed,
}: {
  menuItem?: boolean;
  onDialogClosed?: () => void;
} = {}) {
  const session = useWarehouseSession();
  const audit = useAuditCapture();
  const [open, setOpen] = useState(false);
  const machineBusy = !!session.gantry?.activeOperationId;
  const close = () => {
    setOpen(false);
    onDialogClosed?.();
  };
  return (
    <>
      <button type="button" role={menuItem ? "menuitem" : undefined} onClick={() => setOpen(true)}
        disabled={session.scanning || audit.pending !== null || audit.submitting}
        className={menuItem
          ? "flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-accent-tint hover:text-accent disabled:pointer-events-none disabled:opacity-40"
          : BUTTON_VARIANTS.approve}>
        {session.scanning || audit.submitting ? "Scanning…" : "Register an item"}
      </button>
      {open && !session.scanning && !audit.pending && <CapturePopup title="Register an item"
        onClose={close} disabled={machineBusy}
        onCapture={() => { close(); session.startPiScan(); }} />}
    </>
  );
}

/** Existing identification/catalog logic; only its presentation timing changes. */
export function ScanResultDialog() {
  const session = useWarehouseSession();
  return <GuidedPutawayDialog
    scanState={session.scanState} identity={session.identity} confirmed={session.confirmed}
    identification={session.identification} identityRejected={session.identityRejected}
    identityBusy={session.identityBusy} identityError={session.identityError}
    openRequestVersion={session.guidedPutawayRequestVersion} bins={session.bins}
    gantry={session.gantry} shots={session.shots} onSelectIdentity={session.selectCandidate}
    onRejectIdentity={session.rejectIdentification} onReconsiderIdentity={session.reconsiderIdentification}
    onRegisterNewPart={session.registerNewPart} registeringPart={session.registeringPart}
    registerError={session.registerError} onWarehouseChanged={session.refresh}
  />;
}
