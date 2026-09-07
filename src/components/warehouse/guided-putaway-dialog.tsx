"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GantryStatus } from "@/lib/gantry/types";
import type { Shot } from "@/lib/shots-db";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { groupBinsInShelfOrder } from "@/lib/warehouse/bin-layout";
import { evaluatePutawayDestination } from "@/lib/warehouse/putaway-destination";
import type {
  GuidedGantryStatus,
  GuidedPutawayResult,
} from "@/lib/warehouse/guided-putaway-types";
import type {
  ConfirmedIdentity,
  PendingIdentification,
  ScanState,
} from "./state";
import type { ScanIdentityStatus } from "@/lib/warehouse/dashboard-presentation";
import { CatalogResolutionCard } from "./catalog-resolution-card";
import { CurrentScanPanel } from "./current-scan-panel";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, ErrorNote } from "./ui";

type Phase =
  | "CHOOSING"
  | "RESERVING"
  | "FETCHING"
  | "AWAITING_PLACEMENT"
  | "RETURNING"
  | "SAVING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

interface PutawayOperation {
  movementId: string;
  destinationBinCode: string;
  part: { partId: string; sku: string; canonicalName: string };
}

async function postJson(url: string, body: unknown = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

const GANTRY_LABELS: Record<GuidedGantryStatus, string> = {
  IDLE: "Ready",
  FETCHING_BIN: "Fetching bin",
  WAITING_FOR_PLACEMENT: "Waiting for placement",
  RETURNING_BIN: "Returning bin",
  COMPLETED: "Movement complete",
  FAILED: "Movement failed",
};

function toneForStatus(status: GuidedGantryStatus) {
  if (status === "COMPLETED") {
    return "border-success/40 bg-success-soft text-success";
  }
  if (status === "FAILED") {
    return "border-danger/40 bg-danger-soft text-danger";
  }
  if (status === "WAITING_FOR_PLACEMENT") {
    return "border-warn/40 bg-warn-soft text-warn";
  }
  return "border-accent-soft/60 bg-accent-tint text-accent";
}

function destinationReasonLabel(
  reason: ReturnType<typeof evaluatePutawayDestination>["reason"],
): string {
  switch (reason) {
    case "FULL":
      return "Full";
    case "RESERVED":
      return "Reserved";
    case "DISABLED":
      return "Disabled";
    case "DIFFERENT_PART":
      return "Different item";
    case "INCONSISTENT":
      return "Needs review";
    default:
      return "Compatible";
  }
}

function LiveStatus({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string;
  detail: string;
  status: GuidedGantryStatus;
}) {
  return (
    <div className={`rounded-xl border p-3 ${toneForStatus(status)}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
      <p className="mt-1 font-mono text-[10px] opacity-70">{detail}</p>
    </div>
  );
}

/**
 * Why the slot picker has nothing to offer, or null when it does.
 *
 * The grid used to render ONLY for a ready identity, with no else branch, so a
 * scan the catalog does not recognise opened this dialog onto dead air: no
 * slots, no count, no reason — and, because the gantry panel only mounts once a
 * slot has been chosen, no motion either. Two symptoms, one silence. The
 * warehouse was behaving exactly as designed and the operator had no way to
 * know that.
 *
 * The identity rule itself is deliberately unchanged: only MATCHED or
 * HUMAN_CONFIRMED may pick a slot. This only says so out loud.
 */
function putawayBlockedReason(
  identity: ScanIdentityStatus | null,
  matchUnavailable: boolean,
  identityRejected: boolean,
): string | null {
  if (identity === "MATCHED" || identity === "HUMAN_CONFIRMED") return null;
  if (matchUnavailable) {
    return "The catalog matcher could not be reached, so this scan has no catalog identity yet. The measurement above is unaffected — retry once the service is back.";
  }
  switch (identity) {
    case "AMBIGUOUS":
      return identityRejected
        ? "This scan has no catalog identity yet — register it as a new part in the identification card above, or scan again."
        : "The matcher cannot tell which catalog part this is. Choose the correct part above before picking a slot.";
    case "NO_MATCH":
      return "No catalog part is close enough to this scan. Register it as a new catalog part below, or scan a part the catalog already knows.";
    case "INVALID_SCAN":
      return "This measurement was rejected as warehouse evidence, so it cannot be put away. Scan the part again — a person cannot override a measurement the pipeline rejected.";
    default:
      return "This scan has not been compared against the catalog yet.";
  }
}

function GantryMotion({ phase, binCode }: { phase: Phase; binCode: string | null }) {
  const moving = phase === "FETCHING" || phase === "RETURNING";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated p-4">
      <div className="relative mx-auto h-28 max-w-2xl">
        <div className="absolute left-4 right-4 top-5 h-1 rounded-full bg-line" />
        <div className="absolute left-4 top-12 flex h-14 w-24 items-center justify-center rounded-lg border border-accent-soft bg-accent-tint font-mono text-[10px] text-accent">
          INTAKE
        </div>
        <div className="absolute right-4 top-12 flex h-14 w-24 items-center justify-center rounded-lg border border-line bg-surface font-mono text-[10px] text-ink-muted">
          {binCode ?? "SLOT"}
        </div>
        <div
          className={`absolute top-2 h-10 w-12 rounded-md border border-warn/60 bg-warn-soft shadow-[0_0_22px_rgba(217,164,65,0.18)] ${
            phase === "FETCHING"
              ? "animate-bin-fetch"
              : phase === "RETURNING"
                ? "animate-bin-return"
                : phase === "AWAITING_PLACEMENT"
                  ? "gantry-at-intake"
                  : "gantry-at-slot"
          }`}
          aria-hidden="true"
        >
          <div className="mx-auto mt-2 h-5 w-1 rounded-full bg-warn" />
        </div>
      </div>
      <p className="text-center font-mono text-[10px] text-ink-faint">
        {moving ? "Simulated transfer · approximately 5 seconds" : "Guided bin transfer"}
      </p>
    </div>
  );
}

export function GuidedPutawayDialog({
  scanState,
  identity,
  confirmed,
  identification,
  identityRejected,
  identityBusy,
  identityError,
  openRequestVersion,
  bins,
  gantry,
  shots,
  onSelectIdentity,
  onRejectIdentity,
  onReconsiderIdentity,
  onRegisterNewPart,
  registeringPart,
  registerError,
  onCaptureVerification,
  onWarehouseChanged,
}: {
  scanState: ScanState;
  identity: ScanIdentityStatus | null;
  confirmed: ConfirmedIdentity | null;
  identification: PendingIdentification | null;
  identityRejected: boolean;
  identityBusy: boolean;
  identityError: string | null;
  openRequestVersion: number;
  bins: BinView[];
  gantry: GantryStatus | null;
  /** Local capture history — the scan's own photo is looked up here by shotId to upload alongside the putaway. */
  shots: Shot[];
  onSelectIdentity: (partId: string) => void;
  onRejectIdentity: () => void;
  /** Opens a new audited identity choice before any slot is reserved. */
  onReconsiderIdentity: () => void;
  /** Registers the current NO_MATCH scan as a brand-new catalog part. */
  onRegisterNewPart: () => void;
  registeringPart: boolean;
  registerError: string | null;
  /** Captures the current live camera frame without starting a new scan. */
  onCaptureVerification: () => Shot | null;
  onWarehouseChanged: () => void;
}) {
  const scanId = scanState.scan?.scanResult?.scanId ?? null;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("CHOOSING");
  const [selectedBin, setSelectedBin] = useState<string | null>(null);
  const [operation, setOperation] = useState<PutawayOperation | null>(null);
  const [gantryStatus, setGantryStatus] = useState<GuidedGantryStatus>("IDLE");
  const [liveGantry, setLiveGantry] = useState<GantryStatus | null>(null);
  const [placementPhoto, setPlacementPhoto] = useState<Shot | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenOpenRequest = useRef(0);
  const [lastSeenPhase, setLastSeenPhase] = useState(scanState.phase);

  const shelfRows = useMemo(() => groupBinsInShelfOrder(bins), [bins]);
  const identityReady = identity === "MATCHED" || identity === "HUMAN_CONFIRMED";
  const identifiedPartId =
    confirmed?.partId ??
    (scanState.scan?.match?.status === "MATCHED"
      ? scanState.scan.match.matchedPart.id
      : null);
  const destinationChoices = useMemo(
    () =>
      shelfRows.flatMap((row) =>
        row.bins.map((bin) => ({
          bin,
          evaluation: identifiedPartId
            ? evaluatePutawayDestination(bin, identifiedPartId)
            : null,
        })),
      ),
    [identifiedPartId, shelfRows],
  );
  const choiceByBinId = useMemo(
    () => new Map(destinationChoices.map((choice) => [choice.bin.binId, choice])),
    [destinationChoices],
  );
  const compatibleChoices = destinationChoices.filter(
    (choice) => choice.evaluation?.eligible,
  );
  const recommendedChoice =
    compatibleChoices.find((choice) => choice.evaluation?.alreadyStoresPart) ??
    compatibleChoices[0] ??
    null;
  const selectedChoice =
    compatibleChoices.find((choice) => choice.bin.code === selectedBin) ??
    recommendedChoice;
  const fullExistingChoice = destinationChoices.find(
    (choice) =>
      choice.evaluation?.alreadyStoresPart && choice.evaluation.reason === "FULL",
  );
  const blockedReason = putawayBlockedReason(
    identity,
    scanState.scan?.matchError != null,
    identityRejected,
  );

  /**
   * Opens the popup the INSTANT a capture starts, not once matching finishes.
   * MEASURING is entered exactly once per new capture (handleCapture in
   * session.tsx always sets it first). Adjusted directly during render
   * (React's own recommended pattern for "reset state when an external value
   * changes") rather than in a useEffect, which would otherwise fire a
   * cascade of extra renders for what is really just "this render already
   * knows the answer." Everything below CurrentScanPanel still waits for an
   * actual scan object (see the `scanState.scan &&` guard further down), so
   * this only controls WHEN the popup appears and resets, not what it shows.
   */
  if (scanState.phase !== lastSeenPhase) {
    setLastSeenPhase(scanState.phase);
    if (scanState.phase === "MEASURING") {
      setOpen(true);
      setPhase("CHOOSING");
      setSelectedBin(null);
      setOperation(null);
      setGantryStatus("IDLE");
      setPlacementPhoto(null);
      setVerificationError(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (!scanId || openRequestVersion <= seenOpenRequest.current) return;
    seenOpenRequest.current = openRequestVersion;
    setOpen(true);
  }, [openRequestVersion, scanId]);

  useEffect(() => {
    if (phase !== "FETCHING" && phase !== "RETURNING") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/gantry/status", { cache: "no-store" });
        if (response.ok && !stopped) setLiveGantry((await response.json()) as GantryStatus);
      } catch {
        // The high-level operation status remains visible if this optional poll misses.
      }
      if (!stopped) timer = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase]);

  const applyFailure = useCallback((result: Record<string, unknown>) => {
    const envelope = result.error as { message?: unknown } | undefined;
    setPhase("FAILED");
    setError(
      (typeof result.message === "string" ? result.message : null) ??
        (typeof envelope?.message === "string" ? envelope.message : null) ??
        "The guided putaway could not continue.",
    );
    setGantryStatus((result.gantryStatus as GuidedGantryStatus) ?? "FAILED");
  }, []);

  const start = useCallback(async (destinationBinCode: string) => {
    const scanResult = scanState.scan?.scanResult;
    if (!scanResult || !identityReady) return;
    setSelectedBin(destinationBinCode);
    setPhase("RESERVING");
    setGantryStatus("IDLE");
    setPlacementPhoto(null);
    setVerificationError(null);
    setError(null);

    try {
      const shot = scanState.scan ? shots.find((s) => s.id === scanState.scan!.shotId) : undefined;
      const prepared = await postJson("/api/warehouse/guided-putaway", {
        scanResult,
        destinationBinCode,
        ...(confirmed ? { catalogResolutionId: confirmed.resolutionId } : {}),
        ...(shot ? { imageDataUrl: shot.dataUrl } : {}),
      });
      const reserved = prepared.data as unknown as GuidedPutawayResult;
      if (!prepared.ok || !reserved.ok) {
        applyFailure(prepared.data);
        return;
      }
      setOperation({
        movementId: reserved.movementId,
        destinationBinCode: reserved.destinationBinCode,
        part: reserved.part,
      });
      onWarehouseChanged();

      setPhase("FETCHING");
      setGantryStatus("FETCHING_BIN");
      const presentedResponse = await postJson(
        `/api/warehouse/guided-putaway/${reserved.movementId}/present`,
      );
      const presented = presentedResponse.data as unknown as GuidedPutawayResult;
      if (!presentedResponse.ok || !presented.ok) {
        applyFailure(presentedResponse.data);
        onWarehouseChanged();
        return;
      }
      setPhase("AWAITING_PLACEMENT");
      setGantryStatus("WAITING_FOR_PLACEMENT");
      onWarehouseChanged();
    } catch {
      applyFailure({
        message: "The warehouse could not be reached. Check the gantry before retrying.",
        gantryStatus: "FAILED",
      });
    }
  }, [applyFailure, confirmed, identityReady, onWarehouseChanged, scanState.scan, shots]);

  const settle = useCallback(
    async (placed: boolean) => {
      if (!operation) return;
      if (placed && !placementPhoto) {
        setVerificationError("Take a fresh photo of the item inside the bin before returning it.");
        return;
      }
      setPhase("RETURNING");
      setGantryStatus("RETURNING_BIN");
      setVerificationError(null);
      setError(null);
      let returned: GuidedPutawayResult;
      try {
        const response = await postJson(
          `/api/warehouse/guided-putaway/${operation.movementId}/return`,
          placed
            ? {
                placed: true,
                verificationImageDataUrl: placementPhoto!.dataUrl,
                verificationCapturedAt: placementPhoto!.createdAt,
              }
            : { placed: false },
        );
        returned = response.data as unknown as GuidedPutawayResult;
        if (!response.ok || !returned.ok) {
          if (
            !returned.ok &&
            (returned.reason === "placement_photo_required" ||
              returned.reason === "placement_photo_upload_failed")
          ) {
            setPhase("AWAITING_PLACEMENT");
            setGantryStatus("WAITING_FOR_PLACEMENT");
            setVerificationError(returned.message);
            return;
          }
          applyFailure(response.data);
          onWarehouseChanged();
          return;
        }
      } catch {
        applyFailure({
          message:
            "The gantry return result could not be read. Verify the physical bin before continuing.",
          gantryStatus: "FAILED",
        });
        return;
      }

      setGantryStatus(returned.gantryStatus);
      setPhase("SAVING");
      try {
        const commitResponse = await postJson(
          `/api/warehouse/guided-putaway/${operation.movementId}/commit`,
        );
        const committed = commitResponse.data as unknown as GuidedPutawayResult;
        if (!commitResponse.ok || !committed.ok) {
          applyFailure(commitResponse.data);
          onWarehouseChanged();
          return;
        }
        setPhase(placed ? "COMPLETED" : "CANCELLED");
        onWarehouseChanged();
      } catch {
        applyFailure({
          message:
            "The gantry completed, but the inventory result could not be read. Reconciliation is required before acting again.",
          gantryStatus: "COMPLETED",
        });
        onWarehouseChanged();
      }
    },
    [applyFailure, onWarehouseChanged, operation, placementPhoto],
  );

  const captureVerification = useCallback(() => {
    const shot = onCaptureVerification();
    if (!shot) {
      setVerificationError("The camera is not ready. Start the live camera, then retry.");
      return;
    }
    setPlacementPhoto(shot);
    setVerificationError(null);
  }, [onCaptureVerification]);

  // Nothing captured yet — genuinely nothing to show, not even a collapsed
  // reopen button. Every other phase (MEASURING, FAILED, MATCHING, READY) has
  // something worth surfacing, even before a scan object exists.
  if (scanState.phase === "EMPTY") return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={BUTTON_VARIANTS.secondary}>
        {scanState.scan ? "Review latest scan and put away" : "Review scan status"}
      </button>
    );
  }

  const locked = ["RESERVING", "FETCHING", "AWAITING_PLACEMENT", "RETURNING", "SAVING"].includes(
    phase,
  );
  const destination = operation?.destinationBinCode ?? selectedChoice?.bin.code ?? null;
  const destinationBin = bins.find((bin) => bin.code === destination) ?? null;

  return (
    <Modal
      title="Scanned item · guided putaway"
      onClose={() => setOpen(false)}
      dismissible={!locked}
      maxWidthClassName="max-w-4xl"
    >
      <div className="space-y-4">
        {/* The one section that's ALWAYS here — measuring, failed, matching,
            or a settled result. Everything below needs an actual scan object
            to act on, so it waits behind the guard just after this. */}
        <CurrentScanPanel state={scanState} identity={identity} confirmed={confirmed} />

        {scanState.scan && (
        <>
        {/* Renders for the pending AND the rejected state — a rejected
            AMBIGUOUS scan still needs a way forward (registering as new),
            not just a dead end. The component itself returns null once
            neither identification nor rejected applies. */}
        {phase === "CHOOSING" &&
          !identityReady &&
          identity === "AMBIGUOUS" &&
          (identification || identityRejected) && (
          <div className="animate-stage-reveal" data-guided-step="identity">
            <CatalogResolutionCard
              identification={identification}
              confirmed={confirmed}
              rejected={identityRejected}
              busy={identityBusy}
              error={identityError}
              detectedName={scanState.scan?.measurement?.name ?? null}
              onSelect={onSelectIdentity}
              onReject={onRejectIdentity}
              onRegisterNewPart={onRegisterNewPart}
              registeringPart={registeringPart}
              registerError={registerError}
            />
          </div>
        )}

        {phase === "CHOOSING" &&
          !identityReady &&
          identity === "AMBIGUOUS" &&
          !identification &&
          !identityRejected && (
            <section
              className="animate-stage-reveal rounded-xl border border-accent-soft/60 bg-surface p-4"
              data-guided-step="identity"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
                Step 1 · Identification required
              </p>
              <div className="mt-4 flex items-center gap-2.5 text-xs text-ink-muted">
                <span className="animate-spin-slow h-3.5 w-3.5 rounded-full border-2 border-line border-t-accent" />
                Loading catalog choices…
              </div>
            </section>
          )}

        {phase === "CHOOSING" && !identityReady && identity !== "AMBIGUOUS" && (
          <section
            className="animate-stage-reveal rounded-xl border border-accent-soft/60 bg-surface p-4"
            data-guided-step="identity"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
              Step 1 · Identification required
            </p>
            {identity === "NO_MATCH" ? (
              <>
                <p className="mt-2 text-sm font-semibold text-ink">
                  This item is not in the catalog yet.
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                  Register it using this scan&apos;s measurement and photo. Available slots will
                  appear only after its identity is ready.
                </p>
                {registerError && (
                  <div className="mt-3">
                    <ErrorNote>{registerError}</ErrorNote>
                  </div>
                )}
                <button
                  type="button"
                  onClick={onRegisterNewPart}
                  disabled={registeringPart}
                  className={`${BUTTON_VARIANTS.primary} mt-4 w-full sm:w-auto`}
                >
                  {registeringPart ? "Registering…" : "Register as new catalog item"}
                </button>
              </>
            ) : (
              <div className="mt-3">
                <ErrorNote>{blockedReason ?? "Waiting for catalog identification."}</ErrorNote>
              </div>
            )}
          </section>
        )}

        {phase === "CHOOSING" && identityReady && (
          <section
            className="animate-stage-reveal rounded-xl border border-line bg-surface p-4"
            data-guided-step="slots"
          >
            {confirmed && (
              <button
                type="button"
                onClick={() => {
                  setSelectedBin(null);
                  onReconsiderIdentity();
                }}
                disabled={identityBusy}
                className={`${BUTTON_VARIANTS.secondary} mb-4`}
              >
                ← {identityBusy ? "Opening identity choices…" : "Back to identification"}
              </button>
            )}
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  Step 2 · Choose destination
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  The suggested bin keeps identical items together when capacity allows. You may
                  select any other compatible bin before continuing.
                </p>
              </div>
              <span className="font-mono text-xs text-success">
                {compatibleChoices.length} compatible
              </span>
            </div>
            {recommendedChoice && (
              <div className="mt-4 rounded-lg border border-accent-soft/60 bg-accent-tint px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
                  Default destination · {recommendedChoice.bin.code}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {recommendedChoice.evaluation?.alreadyStoresPart
                    ? `This bin already stores the identified item. Adding it here keeps matching stock together: ${recommendedChoice.evaluation.currentQuantity} + 1 = ${recommendedChoice.evaluation.afterQuantity} of ${recommendedChoice.bin.capacity}.`
                    : fullExistingChoice?.evaluation
                      ? `Its existing bin ${fullExistingChoice.bin.code} is full (${fullExistingChoice.evaluation.currentQuantity}/${fullExistingChoice.bin.capacity}), so ${recommendedChoice.bin.code} is the first compatible empty bin: ${recommendedChoice.evaluation?.currentQuantity} + 1 = ${recommendedChoice.evaluation?.afterQuantity}/${recommendedChoice.bin.capacity}.`
                      : `No existing bin currently stores this item with free capacity, so ${recommendedChoice.bin.code} is the first compatible empty bin: ${recommendedChoice.evaluation?.currentQuantity} + 1 = ${recommendedChoice.evaluation?.afterQuantity}/${recommendedChoice.bin.capacity}.`}
                </p>
              </div>
            )}
            {compatibleChoices.length > 0 ? (
              <>
                <div
                  className="mt-4 flex flex-col gap-2 overflow-x-auto pb-1"
                  role="group"
                  aria-label="Putaway destinations in physical shelf order"
                >
                  {shelfRows.map((row) => (
                    <div
                      key={row.bed ?? "unplaced"}
                      className="flex min-w-max items-stretch gap-2"
                      data-shelf-bed={row.bed ?? "unplaced"}
                    >
                      <span className="flex w-10 shrink-0 items-center justify-end pr-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                        {row.bed === null ? "—" : `bed ${row.bed}`}
                      </span>
                      <div
                        className="grid flex-1 gap-2"
                        style={{
                          gridTemplateColumns: `repeat(${row.bins.length}, minmax(7.5rem, 1fr))`,
                        }}
                      >
                        {row.bins.map((bin) => {
                          const choice = choiceByBinId.get(bin.binId);
                          const evaluation = choice?.evaluation;
                          const eligible = evaluation?.eligible === true;
                          const chosen = selectedChoice?.bin.binId === bin.binId;
                          const isDefault = recommendedChoice?.bin.binId === bin.binId;
                          return (
                            <button
                              key={bin.binId}
                              type="button"
                              disabled={!eligible}
                              onClick={() => setSelectedBin(bin.code)}
                              aria-pressed={chosen}
                              aria-label={`${bin.code}, ${
                                evaluation ? destinationReasonLabel(evaluation.reason) : bin.status
                              }, capacity ${evaluation?.currentQuantity ?? bin.totalQuantity} of ${bin.capacity}`}
                              className={`flex min-h-[4.75rem] flex-col items-start justify-center rounded-lg border px-2.5 py-2 text-left transition-all ${
                                chosen
                                  ? "border-accent bg-accent-tint text-accent shadow-[0_0_0_1px_rgba(91,157,217,0.25)]"
                                  : eligible
                                    ? "border-line bg-bg-elevated text-ink-muted hover:border-accent-soft hover:text-ink"
                                    : "border-line/60 bg-bg-elevated/40 text-ink-faint opacity-55"
                              }`}
                            >
                              <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px]">
                                {bin.code}
                                {isDefault && (
                                  <span className="rounded bg-accent/15 px-1 py-0.5 text-[7px] uppercase tracking-[0.08em] text-accent">
                                    Default
                                  </span>
                                )}
                              </span>
                              <span className="mt-1 text-[9px]">
                                {evaluation?.alreadyStoresPart && eligible
                                  ? "Same item"
                                  : evaluation
                                    ? destinationReasonLabel(evaluation.reason)
                                    : bin.status.toLowerCase()}
                              </span>
                              <span className="mt-0.5 font-mono text-[9px]">
                                {eligible && evaluation
                                  ? `${evaluation.currentQuantity} + 1 = ${evaluation.afterQuantity}/${bin.capacity}`
                                  : `${evaluation?.currentQuantity ?? bin.totalQuantity}/${bin.capacity} used`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs text-ink-muted">
                    Selected: <strong className="text-ink">{selectedChoice?.bin.code}</strong>
                    {selectedChoice?.evaluation &&
                      ` · ${selectedChoice.evaluation.currentQuantity} + 1 = ${selectedChoice.evaluation.afterQuantity}/${selectedChoice.bin.capacity}`}
                  </p>
                  <button
                    type="button"
                    onClick={() => selectedChoice && void start(selectedChoice.bin.code)}
                    disabled={!selectedChoice}
                    className={BUTTON_VARIANTS.primary}
                  >
                    Continue with {selectedChoice?.bin.code ?? "selected bin"} →
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-4">
                <ErrorNote>
                  No bin can accept this item. Existing matching bins are full, and no compatible
                  empty bin is currently available.
                </ErrorNote>
              </div>
            )}
          </section>
        )}

        {phase !== "CHOOSING" && (
          <>
            <div className="grid gap-3">
              <LiveStatus
                label="Gantry"
                value={GANTRY_LABELS[gantryStatus]}
                detail={
                  liveGantry ?? gantry
                    ? `${(liveGantry ?? gantry)!.state} · ${(liveGantry ?? gantry)!.currentLocation ?? "HOME"}`
                    : "Reading controller status…"
                }
                status={gantryStatus}
              />
            </div>
            <GantryMotion phase={phase} binCode={destination} />
          </>
        )}

        {phase === "AWAITING_PLACEMENT" && operation && (
          <section className="rounded-xl border border-warn/40 bg-warn-soft p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
              Photo verification required
            </p>
            <p className="mt-2 text-sm text-ink">
              Place <strong>{operation.part.sku}</strong> ({operation.part.canonicalName}) into bin{" "}
              <strong>{operation.destinationBinCode}</strong>, then capture the bin before returning it.
            </p>
            {destinationBin && (
              <p className="mt-1 font-mono text-[10px] text-ink-muted">
                Capacity after placement: {destinationBin.totalQuantity + 1}/{destinationBin.capacity} units
              </p>
            )}

            <div className="mt-4 overflow-hidden rounded-xl border border-line bg-bg-elevated">
              {placementPhoto ? (
                <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  {/* A just-captured local data URL; it is uploaded only when the operator verifies it. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={placementPhoto.dataUrl}
                    alt={`Verification photo for bin ${operation.destinationBinCode}`}
                    className="max-h-64 w-full rounded-lg border border-line object-contain"
                  />
                  <div className="space-y-1 sm:w-44">
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-success">
                      Photo ready
                    </p>
                    <p className="text-xs leading-relaxed text-ink-muted">
                      Check that the item and remaining bin space are clearly visible.
                    </p>
                    <p className="font-mono text-[9px] text-ink-faint">
                      {new Date(placementPhoto.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="px-4 py-7 text-center">
                  <p className="text-xs text-ink-muted">No placement photo captured yet.</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Use the live camera to show the item inside the presented bin.
                  </p>
                </div>
              )}
            </div>

            {verificationError && (
              <div className="mt-3">
                <ErrorNote>{verificationError}</ErrorNote>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => void settle(false)} className={BUTTON_VARIANTS.secondary}>
                No item placed · return bin
              </button>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={captureVerification}
                  className={BUTTON_VARIANTS.secondary}
                >
                  {placementPhoto ? "Retake photo" : "Take verification photo"}
                </button>
                <button
                  type="button"
                  onClick={() => void settle(true)}
                  disabled={!placementPhoto}
                  className={BUTTON_VARIANTS.approve}
                >
                  Verify photo &amp; return bin
                </button>
              </div>
            </div>
          </section>
        )}

        {phase === "COMPLETED" && operation && (
          <div className="rounded-xl border border-success/40 bg-success-soft p-4 text-success">
            <p className="font-semibold">Putaway complete</p>
            <p className="mt-1 text-xs leading-relaxed">
              The verified bin photo was recorded and the gantry returned bin{" "}
              {operation.destinationBinCode} with one {operation.part.sku}.
            </p>
          </div>
        )}

        {phase === "CANCELLED" && (
          <div className="rounded-xl border border-line bg-bg-elevated p-4 text-ink-muted">
            The bin was returned and its reservation was released. No inventory was changed.
          </div>
        )}

        {phase === "FAILED" && error && <ErrorNote>{error}</ErrorNote>}

        {(phase === "COMPLETED" || phase === "CANCELLED" || phase === "FAILED") && (
          <div className="flex justify-end">
            <button type="button" onClick={() => setOpen(false)} className={BUTTON_VARIANTS.secondary}>
              Close
            </button>
          </div>
        )}
        </>
        )}
      </div>
    </Modal>
  );
}
