"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GantryStatus } from "@/lib/gantry/types";
import type { Shot } from "@/lib/shots-db";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import type {
  GuidedDatabaseStatus,
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

const DB_LABELS: Record<GuidedDatabaseStatus, string> = {
  CHECKING: "Checking slot",
  RESERVED: "Slot reserved",
  WAITING_TO_SAVE: "Waiting to save",
  SAVING: "Saving inventory",
  SAVED: "Inventory saved",
  RELEASED: "Reservation released",
  RECONCILIATION_REQUIRED: "Needs reconciliation",
};

const GANTRY_LABELS: Record<GuidedGantryStatus, string> = {
  IDLE: "Ready",
  FETCHING_BIN: "Fetching bin",
  WAITING_FOR_PLACEMENT: "Waiting for placement",
  RETURNING_BIN: "Returning bin",
  COMPLETED: "Movement complete",
  FAILED: "Movement failed",
};

function toneForStatus(status: GuidedDatabaseStatus | GuidedGantryStatus) {
  if (status === "SAVED" || status === "RELEASED" || status === "COMPLETED") {
    return "border-success/40 bg-success-soft text-success";
  }
  if (status === "FAILED" || status === "RECONCILIATION_REQUIRED") {
    return "border-danger/40 bg-danger-soft text-danger";
  }
  if (status === "WAITING_TO_SAVE" || status === "WAITING_FOR_PLACEMENT") {
    return "border-warn/40 bg-warn-soft text-warn";
  }
  return "border-accent-soft/60 bg-accent-tint text-accent";
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
  status: GuidedDatabaseStatus | GuidedGantryStatus;
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
        ? "You rejected every candidate the matcher offered, so this scan has no catalog identity. Scan the part again."
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
  onRegisterNewPart,
  registeringPart,
  registerError,
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
  /** Registers the current NO_MATCH scan as a brand-new catalog part. */
  onRegisterNewPart: () => void;
  registeringPart: boolean;
  registerError: string | null;
  onWarehouseChanged: () => void;
}) {
  const scanId = scanState.scan?.scanResult?.scanId ?? null;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("CHOOSING");
  const [selectedBin, setSelectedBin] = useState<string | null>(null);
  const [operation, setOperation] = useState<PutawayOperation | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState<GuidedDatabaseStatus>("CHECKING");
  const [gantryStatus, setGantryStatus] = useState<GuidedGantryStatus>("IDLE");
  const [liveGantry, setLiveGantry] = useState<GantryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenScan = useRef<string | null>(null);
  const seenOpenRequest = useRef(0);

  const availableBins = useMemo(
    () => bins.filter((bin) => bin.status === "AVAILABLE"),
    [bins],
  );
  const identityReady = identity === "MATCHED" || identity === "HUMAN_CONFIRMED";
  const blockedReason = putawayBlockedReason(
    identity,
    scanState.scan?.matchError != null,
    identityRejected,
  );

  useEffect(() => {
    if (scanState.phase !== "READY" || !scanId || seenScan.current === scanId) return;
    seenScan.current = scanId;
    setOpen(true);
    setPhase("CHOOSING");
    setSelectedBin(null);
    setOperation(null);
    setDatabaseStatus("CHECKING");
    setGantryStatus("IDLE");
    setError(null);
  }, [scanId, scanState.phase]);

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
    setDatabaseStatus(
      (result.databaseStatus as GuidedDatabaseStatus) ?? "RECONCILIATION_REQUIRED",
    );
    setGantryStatus((result.gantryStatus as GuidedGantryStatus) ?? "FAILED");
  }, []);

  const start = useCallback(async (destinationBinCode: string) => {
    const scanResult = scanState.scan?.scanResult;
    if (!scanResult || !identityReady) return;
    setSelectedBin(destinationBinCode);
    setPhase("RESERVING");
    setDatabaseStatus("CHECKING");
    setGantryStatus("IDLE");
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
      setDatabaseStatus("RESERVED");
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
      setDatabaseStatus("WAITING_TO_SAVE");
      setGantryStatus("WAITING_FOR_PLACEMENT");
      onWarehouseChanged();
    } catch {
      applyFailure({
        message: "The warehouse could not be reached. Check the gantry and Supabase state before retrying.",
        databaseStatus: "RECONCILIATION_REQUIRED",
        gantryStatus: "FAILED",
      });
    }
  }, [applyFailure, confirmed, identityReady, onWarehouseChanged, scanState.scan, shots]);

  const settle = useCallback(
    async (placed: boolean) => {
      if (!operation) return;
      setPhase("RETURNING");
      setGantryStatus("RETURNING_BIN");
      setDatabaseStatus(placed ? "WAITING_TO_SAVE" : "RESERVED");
      setError(null);
      let returned: GuidedPutawayResult;
      try {
        const response = await postJson(
          `/api/warehouse/guided-putaway/${operation.movementId}/return`,
          { placed },
        );
        returned = response.data as unknown as GuidedPutawayResult;
        if (!response.ok || !returned.ok) {
          applyFailure(response.data);
          onWarehouseChanged();
          return;
        }
      } catch {
        applyFailure({
          message:
            "The gantry return result could not be read. Verify the physical bin before continuing.",
          databaseStatus: "RECONCILIATION_REQUIRED",
          gantryStatus: "FAILED",
        });
        return;
      }

      setGantryStatus(returned.gantryStatus);
      setDatabaseStatus("SAVING");
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
        setDatabaseStatus(placed ? "SAVED" : "RELEASED");
        setPhase(placed ? "COMPLETED" : "CANCELLED");
        onWarehouseChanged();
      } catch {
        applyFailure({
          message:
            "The gantry completed, but the Supabase result could not be read. Reconciliation is required before acting again.",
          databaseStatus: "RECONCILIATION_REQUIRED",
          gantryStatus: "COMPLETED",
        });
        onWarehouseChanged();
      }
    },
    [applyFailure, onWarehouseChanged, operation],
  );

  if (!scanState.scan) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={BUTTON_VARIANTS.secondary}>
        Review latest scan and put away
      </button>
    );
  }

  const locked = ["RESERVING", "FETCHING", "AWAITING_PLACEMENT", "RETURNING", "SAVING"].includes(
    phase,
  );
  const destination = operation?.destinationBinCode ?? selectedBin;

  return (
    <Modal
      title="Scanned item · guided putaway"
      onClose={() => setOpen(false)}
      dismissible={!locked}
      maxWidthClassName="max-w-4xl"
    >
      <div className="space-y-4">
        <CurrentScanPanel state={scanState} identity={identity} confirmed={confirmed} />

        {identity === "AMBIGUOUS" && identification && (
          <CatalogResolutionCard
            identification={identification}
            confirmed={confirmed}
            rejected={identityRejected}
            busy={identityBusy}
            error={identityError}
            onSelect={onSelectIdentity}
            onReject={onRejectIdentity}
          />
        )}

        {phase === "CHOOSING" && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  Available slots
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {blockedReason
                    ? "Putaway is on hold until this scan has a catalog identity."
                    : "Choose where this identified item will be stored."}
                </p>
              </div>
              {/* Shown even while blocked, on purpose: it separates "the shelf is
                  full" from "the catalog does not know this part", which are
                  two completely different problems for the operator. */}
              <span
                className={`font-mono text-xs ${blockedReason ? "text-ink-faint" : "text-success"}`}
              >
                {availableBins.length} available
              </span>
            </div>
            {blockedReason ? (
              <div className="mt-4 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
                  ! Putaway unavailable
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink">{blockedReason}</p>
                {identity === "NO_MATCH" && (
                  <div className="mt-3 border-t border-warn/30 pt-3">
                    <p className="text-xs leading-relaxed text-ink-muted">
                      This adds{" "}
                      <strong className="text-ink">
                        {scanState.scan?.measurement?.name ?? "this object"}
                      </strong>{" "}
                      to the catalog using the measurement above, then lets this scan continue
                      into the normal slot-picker below.
                    </p>
                    {registerError && (
                      <div className="mt-2">
                        <ErrorNote>{registerError}</ErrorNote>
                      </div>
                    )}
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={onRegisterNewPart}
                        disabled={registeringPart}
                        className={BUTTON_VARIANTS.primary}
                      >
                        {registeringPart ? "Registering…" : "Register as new part"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : availableBins.length > 0 ? (
              <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
                {availableBins.map((bin) => (
                  <button
                    key={bin.binId}
                    type="button"
                    onClick={() => void start(bin.code)}
                    aria-pressed={selectedBin === bin.code}
                    className={`rounded-lg border px-3 py-3 font-mono text-xs transition-all ${
                      selectedBin === bin.code
                        ? "border-accent bg-accent-tint text-accent shadow-[0_0_0_1px_rgba(91,157,217,0.25)]"
                        : "border-line bg-bg-elevated text-ink-muted hover:border-accent-soft hover:text-ink"
                    }`}
                  >
                    {bin.code}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-4">
                <ErrorNote>No slots are currently available for putaway.</ErrorNote>
              </div>
            )}
          </section>
        )}

        {phase !== "CHOOSING" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <LiveStatus
                label="Supabase database"
                value={DB_LABELS[databaseStatus]}
                detail={destination ? `Destination ${destination}` : "Validating destination…"}
                status={databaseStatus}
              />
            </div>
            <GantryMotion phase={phase} binCode={destination} />
          </>
        )}

        {phase === "AWAITING_PLACEMENT" && operation && (
          <section className="rounded-xl border border-warn/40 bg-warn-soft p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
              Human confirmation required
            </p>
            <p className="mt-2 text-sm text-ink">
              Place <strong>{operation.part.sku}</strong> ({operation.part.canonicalName}) into bin{" "}
              <strong>{operation.destinationBinCode}</strong>. Has the item been placed inside?
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => void settle(false)} className={BUTTON_VARIANTS.secondary}>
                No, return empty bin
              </button>
              <button type="button" onClick={() => void settle(true)} className={BUTTON_VARIANTS.approve}>
                Yes, item placed
              </button>
            </div>
          </section>
        )}

        {phase === "COMPLETED" && operation && (
          <div className="rounded-xl border border-success/40 bg-success-soft p-4 text-success">
            <p className="font-semibold">Putaway complete</p>
            <p className="mt-1 text-xs leading-relaxed">
              The gantry returned bin {operation.destinationBinCode}, and Supabase saved one{" "}
              {operation.part.sku} in that slot.
            </p>
          </div>
        )}

        {phase === "CANCELLED" && (
          <div className="rounded-xl border border-line bg-bg-elevated p-4 text-ink-muted">
            The empty bin was returned and its reservation was released. No inventory was saved.
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
      </div>
    </Modal>
  );
}
