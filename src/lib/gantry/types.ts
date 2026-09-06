/**
 * The gantry abstraction's vocabulary.
 *
 * Nothing above this layer should care whether the machine underneath is the
 * simulator or, later, real hardware — so every type here describes *machine
 * execution*, never warehouse truth. The gantry knows how to move a part
 * between locations; it does not know what inventory is, and it never decides
 * what the warehouse believes.
 *
 * Types only, no runtime dependency on the database, so a dev panel in the
 * browser can render gantry state without pulling in Prisma.
 */
import { SEED_BIN_CODES } from "@/lib/warehouse/types";

/**
 * The bins the gantry can reach — the same six the warehouse seeds, reused
 * rather than redeclared so there is exactly one bin-code list in the repo.
 * If the warehouse ever gains bins beyond the seeded set, this must become a
 * lookup against the Bin table instead of a static list.
 */
export const GANTRY_BIN_CODES = SEED_BIN_CODES;
export type WarehouseBinCode = (typeof GANTRY_BIN_CODES)[number];

/**
 * Logical end points that are not storage. Deliberately NOT Bin rows: the
 * warehouse must never see an intake conveyor as somewhere stock can live,
 * and bin-availability logic must never consider them.
 */
export const GANTRY_STATIONS = ["INTAKE", "OUTPUT"] as const;
export type GantryStation = (typeof GANTRY_STATIONS)[number];

export type GantryLocation = WarehouseBinCode | GantryStation;

export function isWarehouseBinCode(value: unknown): value is WarehouseBinCode {
  return typeof value === "string" && (GANTRY_BIN_CODES as readonly string[]).includes(value);
}

export function isGantryStation(value: unknown): value is GantryStation {
  return typeof value === "string" && (GANTRY_STATIONS as readonly string[]).includes(value);
}

export function isGantryLocation(value: unknown): value is GantryLocation {
  return isWarehouseBinCode(value) || isGantryStation(value);
}

/**
 * `OFFLINE` is reserved for a controller that is not reachable — the
 * simulator never reports it, since it is always available in-process.
 * `ERROR` is likewise unused by the simulator, which records the failure on
 * the operation and returns to IDLE (see simulator.ts).
 */
export const GANTRY_STATES = [
  "OFFLINE",
  "IDLE",
  "HOMING",
  "MOVING",
  "PICKING",
  "DROPPING",
  "ERROR",
] as const;
export type GantryState = (typeof GANTRY_STATES)[number];

export const GANTRY_OPERATION_TYPES = ["HOME", "PUTAWAY", "RETRIEVAL"] as const;
export type GantryOperationType = (typeof GANTRY_OPERATION_TYPES)[number];

/** `CANCELLED` is part of the contract but nothing cancels an operation in this milestone. */
export const GANTRY_OPERATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type GantryOperationStatus = (typeof GANTRY_OPERATION_STATUSES)[number];

/** HARDWARE is reserved for a later milestone; no hardware controller exists yet. */
export const GANTRY_MODES = ["SIMULATION", "HARDWARE"] as const;
export type GantryMode = (typeof GANTRY_MODES)[number];

/** Deterministic failure kinds the simulator can be told to inject. Never random. */
export const GANTRY_FAILURE_KINDS = [
  "pickup_failed",
  "drop_failed",
  "movement_timeout",
  "controller_error",
] as const;
export type GantryFailureKind = (typeof GANTRY_FAILURE_KINDS)[number];

export interface GantryStatus {
  mode: GantryMode;
  state: GantryState;
  /** Where the head last arrived. null means the home position (or not yet homed). */
  currentLocation: GantryLocation | null;
  /** Whether a successful home() has established the reference position. */
  homed: boolean;
  activeOperationId: string | null;
  /** The failure of the most recent failed operation, cleared by the next success. */
  lastError: string | null;
}

/**
 * One machine execution record.
 *
 * NOT a warehouse `Movement`. A Movement is the warehouse's intent ("we mean
 * to move BRG-6204 from INTAKE to B03"); a GantryOperation is the machine's
 * account of doing it. Linking the two is a later milestone's job.
 */
export interface GantryOperation {
  operationId: string;
  type: GantryOperationType;
  source: GantryLocation | null;
  destination: GantryLocation | null;
  status: GantryOperationStatus;
  startedAt: number | null;
  completedAt: number | null;
  /** A GantryFailureKind when the operation failed, else null. */
  error: string | null;
}

export interface PutawayRequest {
  source: GantryStation;
  destination: WarehouseBinCode;
}

export interface RetrievalRequest {
  source: WarehouseBinCode;
  destination: GantryStation;
}
