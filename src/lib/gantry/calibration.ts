/**
 * WHERE THINGS PHYSICALLY ARE — the machine's calibration.
 *
 * ⚠️  EVERY NUMBER BELOW IS A PLACEHOLDER. Nothing here has been measured
 *     against the real rack. `CALIBRATED` is false, and a hardware controller
 *     must refuse to move while it stays false: coordinates that look
 *     plausible are more dangerous than coordinates that are obviously
 *     missing, because they fail by driving into a shelf rather than by
 *     throwing.
 *
 * WHY THIS IS A FILE AND NOT THE DATABASE. These numbers command a physical
 * machine. In git they are diffable and reviewable — a Z of 89 where 890 was
 * meant shows up in a pull request. In a table they are one UPDATE away from
 * a crash, with no history and no review. Three more reasons:
 *
 *   - the gantry layer touches no database at all today, and making it query
 *     Prisma to find out where things are would invert that dependency;
 *   - the controller is constructed at startup, before and independently of
 *     any database connection;
 *   - machine truth is not warehouse truth. Shim a rack leg and every
 *     coordinate changes while the warehouse state does not; bolt on a
 *     different gantry and every coordinate changes while B4-02 still holds
 *     the same bearings. Different facts, different lifetimes.
 *
 * A teach UI, if one is built, should WRITE this file rather than a table, so
 * the audit trail survives.
 *
 * AXIS CONVENTION, seen standing in front of the rack:
 *
 *   X  along the shelf, left to right.   0 at the left upright.
 *   Y  into the shelf, front to back.    0 at the front face of a bed.
 *   Z  up.                               0 at the floor.
 *
 * ⚠️  THE Y AXIS IS AN ASSUMPTION. The bin boxes are 12 inches deep, so
 *     something must travel into the shelf to reach one. Whether that is a
 *     third motor, a telescoping fork or an arm is undecided; if the machine
 *     turns out to be X/Z only it can reach the FACE of a bin and no more,
 *     and no calibration fixes that. Settle it before measuring anything.
 */
import { parseBinCode, SLOTS_PER_BED, STORAGE_BEDS, type BinCode } from "@/lib/warehouse/types";
import type { GantryLocation, GantryStation } from "./types";

/**
 * False until every number here has been measured on the real rack.
 *
 * The simulator ignores it — it moves between named locations and never reads
 * a coordinate. It exists for the hardware controller of a later milestone,
 * which must treat "not calibrated" as a reason to refuse.
 */
export const CALIBRATED = false;

/** Millimetres, everywhere. No inches, no steps, no encoder counts above the driver. */
export interface GantryPosition {
  xMM: number;
  yMM: number;
  zMM: number;
}

/* ------------------------------------------------------------ the shelf */

/**
 * The storage bay as a regular grid.
 *
 * Six beds of five slots is thirty positions, but only these few numbers are
 * independent — the rest is arithmetic. That matters for more than tidiness:
 * re-measuring one origin after the rack shifts beats re-measuring thirty
 * positions, and a typo in a pitch is visible in a way that a typo in one of
 * thirty absolute triples is not.
 *
 * PLACEHOLDER VALUES. Slot pitch is a 4" bin box (101.6mm) plus a little
 * clearance; bed pitch is a guess at the beam spacing in the build photo.
 */
export const SHELF_GRID = {
  /** Centre of bed 1, slot 1 — the anchor everything else is measured from. */
  origin: { xMM: 120, yMM: 0, zMM: 210 } satisfies GantryPosition,
  /** Centre-to-centre between neighbouring slots, along X. */
  slotPitchMM: 105,
  /** Centre-to-centre between neighbouring beds, along Z. */
  bedPitchMM: 300,
  /** How far in along Y the gripper travels to sit inside a bin box. */
  approachDepthMM: 180,
} as const;

/**
 * Per-bin corrections, as DELTAS from the derived grid position.
 *
 * Deliberately empty, and deliberately deltas. A bent beam or a sagging bed
 * makes one slot disagree with the model by a few millimetres; recording
 * "B6-03 sits 4mm low" is reviewable, whereas recording thirty absolute
 * triples means a wrong one looks exactly like a right one.
 *
 * Add an entry only when a derived position is measurably wrong.
 */
export const BIN_CORRECTIONS: Partial<Record<BinCode, Partial<GantryPosition>>> = {
  // "B6-03": { zMM: -4 },
};

/* ---------------------------------------------------------- the station */

/**
 * The scan station — the table carrying the camera and the calibration mat.
 *
 * One table, two logical roles: it is INTAKE when a part is arriving and
 * OUTPUT when one is being delivered. They share a position today because
 * they share a table; they stay separate entries because the contract keeps
 * the direction, and a later build may well split them.
 */
export const STATION_POSITIONS: Record<GantryStation, GantryPosition> = {
  INTAKE: { xMM: 900, yMM: 120, zMM: 240 },
  OUTPUT: { xMM: 900, yMM: 120, zMM: 240 },
};

/**
 * The fixed spot on the mat where the operator sets a part to be picked up.
 *
 * WHY A FIXED MARK. A ScanResult carries the object's SIZE and ANGLE but not
 * its POSITION on the mat — there is no centroid in the contract, and
 * matMeasurement computes none. So the machine cannot currently be told where
 * on that table to reach. A painted square the operator always uses reduces
 * that to one known position and defers the mat-to-gantry frame transform
 * entirely.
 *
 * The alternative — picking from wherever the part happens to lie — needs the
 * mat's origin and rotation in gantry coordinates AND a centroid added to
 * ScanResult. That is a real feature, not a calibration value, and it changes
 * a frozen contract. Later.
 */
export const PICKUP_MARK: GantryPosition = { xMM: 900, yMM: 120, zMM: 240 };

/* ------------------------------------------------------------- clearance */

/**
 * Height the head travels at between locations, so it clears the lip of every
 * bin box instead of dragging across the shelf. Must sit above the tallest
 * loaded bin, not merely above an empty one.
 */
export const SAFE_TRAVEL_ZMM = 1900;

/** Y the head retracts to before any X or Z movement. Outside the shelf. */
export const RETRACTED_YMM = 0;

/* ------------------------------------------------------------- resolving */

/**
 * Where a bin is, derived from its code and then corrected.
 *
 * `B4-02` is bed 4, slot 2, so this is arithmetic rather than a lookup table
 * somebody has to keep in step with the shelf. Returns null for a code that
 * is not a real slot, so an unknown location can never silently resolve to
 * the origin — which is a position the machine would happily drive to.
 */
export function resolveBinPosition(code: string): GantryPosition | null {
  const parsed = parseBinCode(code);
  if (!parsed) return null;

  const derived: GantryPosition = {
    xMM: SHELF_GRID.origin.xMM + (parsed.slot - 1) * SHELF_GRID.slotPitchMM,
    yMM: SHELF_GRID.origin.yMM + SHELF_GRID.approachDepthMM,
    zMM: SHELF_GRID.origin.zMM + (parsed.bed - 1) * SHELF_GRID.bedPitchMM,
  };

  const correction = BIN_CORRECTIONS[code as BinCode];
  if (!correction) return derived;

  return {
    xMM: derived.xMM + (correction.xMM ?? 0),
    yMM: derived.yMM + (correction.yMM ?? 0),
    zMM: derived.zMM + (correction.zMM ?? 0),
  };
}

/** Where any gantry location is — a storage bin or a station. Null if unknown. */
export function resolvePosition(location: GantryLocation): GantryPosition | null {
  if (location === "INTAKE" || location === "OUTPUT") return STATION_POSITIONS[location];
  return resolveBinPosition(location);
}

/**
 * The whole calibration as one value, for a hardware adapter to read at
 * construction and for a future teach UI to serialise back over this file.
 */
export const GANTRY_CALIBRATION = {
  calibrated: CALIBRATED,
  units: "mm",
  beds: STORAGE_BEDS,
  slotsPerBed: SLOTS_PER_BED,
  grid: SHELF_GRID,
  corrections: BIN_CORRECTIONS,
  stations: STATION_POSITIONS,
  pickupMark: PICKUP_MARK,
  safeTravelZMM: SAFE_TRAVEL_ZMM,
  retractedYMM: RETRACTED_YMM,
} as const;
