/**
 * Where the gantry arm is, expressed in the rack illustration's own terms.
 *
 * Pure derivation, types only, no React and no server imports — the digital
 * warehouse draws whatever this returns, and this returns nothing that is not
 * already a fact reported by the gantry controller or the warehouse database.
 *
 * TWO SOURCES, ONE PICTURE.
 *  - `GantryStatus` says what the MACHINE is doing (moving, picking, dropping)
 *    and where its head last ARRIVED. It does not know what the trip is for.
 *  - The active `Movement` (or the running inventory audit) says what the trip
 *    IS: which two named points, and why.
 *
 * Neither alone is enough to draw the arm, and nothing here invents a position
 * the controller has not reported: while the head is between two points the
 * illustration animates towards the leg's end point, it does not pretend to
 * know how far along it is.
 */
import type { GantryStatus, GantryLocation } from "@/lib/gantry/types";
import { isGantryStation } from "@/lib/gantry/types";
import type { InventoryAuditView, MovementRowView } from "./dashboard-types";

/** What the carriage is doing at the position it is drawn in. */
export type RackArmPhase =
  | "HOME"
  /** Between two named points, heading for `location`. */
  | "TRAVELLING"
  /** Closing on a load at `location`. */
  | "PICKING"
  /** Releasing a load at `location`. */
  | "DROPPING"
  /** Holding station at `location` — a presented bin waiting on a person. */
  | "PARKED"
  /** The controller is unreachable or has latched a failure. */
  | "FAULT";

export interface RackArmState {
  /** Where to draw the arm. `null` is the home position at the top of the rail. */
  location: GantryLocation | null;
  phase: RackArmPhase;
  /** True once the arm has been to one end of the trip and is holding the load. */
  carrying: boolean;
  /** The shelf bin this operation concerns, for the cell highlight. */
  focusBin: string | null;
  /** One short operator-facing line. Never a guess: it names the real trip. */
  label: string;
  /** The trip's two named end points, in travel order. */
  route: { from: string; to: string } | null;
}

/**
 * Statuses the audit service writes exactly once, at the end of one bin's
 * audit. A BinAudit that is not one of these has not finished, so the machine
 * is still working on it (`PENDING` before it starts, `RUNNING` during).
 */
const TERMINAL_BIN_AUDIT_STATUSES = new Set([
  "VERIFIED",
  "AUTO_RECONCILED",
  "REVIEW_REQUIRED",
  "FAILED",
]);

/** Audit-run statuses that mean the run is still on the machine. */
const LIVE_AUDIT_RUN_STATUSES = new Set(["PENDING", "RUNNING"]);

/**
 * The bin the running audit is physically handling, or null when no audit is
 * in flight. `RUNNING` wins over `PENDING`: a run audits one bin at a time, so
 * the started one is the one the arm is holding.
 */
export function activeAuditBinCode(audit: InventoryAuditView | null | undefined): string | null {
  if (!audit || !LIVE_AUDIT_RUN_STATUSES.has(audit.status)) return null;
  const running = audit.bins.find((bin) => bin.status === "RUNNING");
  if (running) return running.binCode;
  const unfinished = audit.bins.find((bin) => !TERMINAL_BIN_AUDIT_STATUSES.has(bin.status));
  return unfinished?.binCode ?? null;
}

const IDLE_STATE: RackArmState = {
  location: null,
  phase: "HOME",
  carrying: false,
  focusBin: null,
  label: "Idle at home",
  route: null,
};

function verbFor(kind: string, phase: RackArmPhase): string {
  if (phase === "PICKING") return "Picking up";
  if (phase === "DROPPING") return "Setting down";
  if (phase === "PARKED") return "Holding";
  switch (kind) {
    case "AUDIT":
      return "Auditing";
    case "PUTAWAY":
      return "Putting away";
    case "RETRIEVAL":
      return "Retrieving";
    case "TRANSFER":
      return "Transferring";
    default:
      return "Moving";
  }
}

/**
 * The arm, from the two authoritative feeds.
 *
 * The leg logic is the whole trick. The controller sets `currentLocation` on
 * ARRIVAL, so during a move it still reads as the point the head left. That is
 * exactly what says which leg is running: standing at one end of the trip and
 * moving means the other end is the destination, and that the load is already
 * on board.
 */
export function deriveRackArmState({
  gantry,
  activeMovement,
  latestAudit,
}: {
  gantry: GantryStatus | null | undefined;
  activeMovement: MovementRowView | null | undefined;
  latestAudit: InventoryAuditView | null | undefined;
}): RackArmState {
  const state = gantry?.state ?? null;
  const at = gantry?.currentLocation ?? null;

  const auditBin = activeAuditBinCode(latestAudit);
  const operation = gantry?.operation;
  // The controller identifies the actual leg; do not guess direction from
  // its last arrival (the first, empty move can also start at an endpoint).
  if (gantry && operation) {
    const focusBin = [operation.source, operation.destination].find(
      (point): point is string => point !== null && !isGantryStation(point),
    ) ?? null;
    const fault = state === "ERROR" || state === "OFFLINE" || !!gantry.lastError;
    const phase: RackArmPhase = fault ? "FAULT"
      : state === "MOVING" || state === "HOMING" ? "TRAVELLING"
      : state === "PICKING" || state === "DROPPING" ? state
      : at === null ? "HOME" : "PARKED";
    const location = gantry.motion ? gantry.motion.to : at;
    return {
      location, phase, focusBin, carrying: gantry.carrying ?? false,
      label: fault ? `Movement stopped · ${gantry.lastError ?? "controller unavailable"}`
        : phase === "TRAVELLING" ? `${gantry.carrying ? "Carrying bin" : "Positioning carriage"} → ${location ?? "HOME"}`
        : phase === "PICKING" ? `Securing bin · ${focusBin ?? at}`
        : phase === "DROPPING" ? `Placing bin · ${at}`
        : `Gantry ready · ${at ?? "HOME"}`,
      route: operation.source && operation.destination
        ? { from: operation.source, to: operation.destination } : null,
    };
  }

  // The trip: two named end points and what it is for. An audit outranks a
  // movement because an audit run drives the machine directly and the movement
  // it might sit next to is not the trip currently on the rail.
  let trip: { a: string; b: string } | null = null;
  let kind = "";
  if (auditBin) {
    trip = { a: auditBin, b: "SCAN_STATION" };
    kind = "AUDIT";
  } else if (activeMovement?.source && activeMovement.destination) {
    trip = { a: activeMovement.source, b: activeMovement.destination };
    kind = activeMovement.type;
  }

  const binEndpoint = trip
    ? [trip.a, trip.b].find((point) => !isGantryStation(point)) ?? null
    : null;

  if (state === "OFFLINE" || state === null) {
    return {
      ...IDLE_STATE,
      location: at,
      phase: "FAULT",
      focusBin: binEndpoint,
      label: "Controller offline",
    };
  }

  if (state === "ERROR") {
    return {
      location: at,
      phase: "FAULT",
      carrying: false,
      focusBin: binEndpoint,
      label: gantry?.lastError ? `Fault · ${gantry.lastError}` : "Controller fault",
      route: null,
    };
  }

  if (state === "HOMING") {
    return { ...IDLE_STATE, phase: "TRAVELLING", label: "Homing" };
  }

  if (!trip) {
    return { ...IDLE_STATE, location: at, carrying: gantry?.carrying ?? false,
      phase: state === "IDLE" ? (at ? "PARKED" : "HOME") : "TRAVELLING",
      label: state === "IDLE" ? `Gantry ready · ${at ?? "HOME"}` : "Moving" };
  }

  const atEndpoint = at === trip.a || at === trip.b;

  if (state === "PICKING" || state === "DROPPING") {
    const location = at ?? (state === "PICKING" ? trip.a : trip.b);
    const phase: RackArmPhase = state;
    return {
      location,
      phase,
      carrying: state === "DROPPING",
      focusBin: isGantryStation(location) ? binEndpoint : location,
      label: `${verbFor(kind, phase)} · ${location}`,
      route: { from: trip.a, to: trip.b },
    };
  }

  if (state === "MOVING") {
    // Standing at one end means the other end is where this leg is going.
    const heading: GantryLocation = at === trip.a ? trip.b : at === trip.b ? trip.a : trip.a;
    return {
      location: heading,
      phase: "TRAVELLING",
      carrying: atEndpoint,
      focusBin: isGantryStation(heading) ? binEndpoint : heading,
      label: `${verbFor(kind, "TRAVELLING")} · ${at ?? "HOME"} → ${heading}`,
      route: { from: at ?? "HOME", to: heading },
    };
  }

  // IDLE with work still open: a presented bin waiting on a person, or a
  // multi-step workflow between machine moves. The arm is where it stopped.
  const location = at ?? trip.a;
  return {
    location,
    phase: "PARKED",
    carrying: false,
    focusBin: isGantryStation(location) ? binEndpoint : location,
    label: `${verbFor(kind, "PARKED")} · ${location}`,
    route: { from: trip.a, to: trip.b },
  };
}
