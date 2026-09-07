/**
 * Deterministic input validation for the warehouse layer — no framework, the
 * same collect-every-issue-then-reject approach the ScanResult conversion
 * uses (see scan-result.ts). Every service function runs its input through
 * here, so a route handler cannot smuggle malformed data past the DB by
 * calling the service directly.
 */
import { WarehouseError } from "./errors";
import {
  BIN_STATUSES,
  MOVEMENT_STATUSES,
  MOVEMENT_TYPES,
  type AddBinsToBedInput,
  type BinStatus,
  type CreateBedInput,
  type CreateBinInput,
  type CreateMovementInput,
  type CreatePartInput,
  type InventoryMutationInput,
  type MovementStatus,
  type MovementType,
  type UpdateBinInput,
} from "./types";

/** Sanity ceiling on a single create-bed/add-to-bed request — not a domain limit, just a fat-finger guard. */
const MAX_SLOTS_PER_REQUEST = 100;

class IssueCollector {
  readonly issues: string[] = [];

  add(issue: string) {
    this.issues.push(issue);
  }

  /** Non-empty after trimming, else records an issue and returns "". */
  requireText(field: string, value: unknown, maxLength = 200): string {
    if (typeof value !== "string" || value.trim() === "") {
      this.add(`${field} must be a non-empty string`);
      return "";
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
      this.add(`${field} must be at most ${maxLength} characters`);
      return trimmed.slice(0, maxLength);
    }
    return trimmed;
  }

  /** Absent (null/undefined/blank) is fine; a present value must be text. */
  optionalText(field: string, value: unknown, maxLength = 1000): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      this.add(`${field} must be a string when present`);
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (trimmed.length > maxLength) {
      this.add(`${field} must be at most ${maxLength} characters`);
      return trimmed.slice(0, maxLength);
    }
    return trimmed;
  }

  /** Absent is fine; a present dimension must be finite and > 0. */
  optionalDimension(field: string, value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.add(`${field} must be a finite number when present`);
      return null;
    }
    if (value <= 0) {
      this.add(`${field} must be greater than 0 when present`);
      return null;
    }
    return value;
  }

  /** Like positiveInteger, but 0 is allowed — for a target quantity, not a delta. */
  nonNegativeInteger(field: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      this.add(`${field} must be an integer >= 0`);
      return 0;
    }
    return value;
  }

  positiveInteger(field: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.add(`${field} must be an integer`);
      return 0;
    }
    if (value <= 0) {
      this.add(`${field} must be greater than 0`);
      return 0;
    }
    return value;
  }

  /** Absent (null/undefined) is fine; a present value must be a positive integer. */
  optionalPositiveInteger(field: string, value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      this.add(`${field} must be a positive integer when present`);
      return null;
    }
    return value;
  }

  /** Absent (undefined) falls back to `fallback`; a present value must be a real boolean. */
  optionalBoolean(field: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      this.add(`${field} must be a boolean when present`);
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], fallback: T): T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.add(`${field} must be one of: ${allowed.join(", ")}`);
      return fallback;
    }
    return value as T;
  }

  /** Throws a single validation_failed carrying every issue found. */
  throwIfInvalid(what: string): void {
    if (this.issues.length > 0) {
      throw new WarehouseError("validation_failed", `Invalid ${what}.`, this.issues);
    }
  }
}

export interface ValidatedPart {
  sku: string;
  canonicalName: string;
  category: string | null;
  description: string | null;
  lengthMM: number | null;
  widthMM: number | null;
  heightMM: number | null;
  returnable: boolean;
  imageUrl: string | null;
}

export function validateCreatePart(input: CreatePartInput): ValidatedPart {
  const c = new IssueCollector();
  const part: ValidatedPart = {
    // SKUs are matched exactly elsewhere, so normalize case once here.
    sku: c.requireText("sku", input?.sku, 64).toUpperCase(),
    canonicalName: c.requireText("canonicalName", input?.canonicalName),
    category: c.optionalText("category", input?.category, 64),
    description: c.optionalText("description", input?.description),
    lengthMM: c.optionalDimension("lengthMM", input?.lengthMM),
    widthMM: c.optionalDimension("widthMM", input?.widthMM),
    heightMM: c.optionalDimension("heightMM", input?.heightMM),
    returnable: c.optionalBoolean("returnable", input?.returnable, false),
    imageUrl: c.optionalText("imageUrl", input?.imageUrl, 500),
  };
  c.throwIfInvalid("part");
  return part;
}

export interface ValidatedBin {
  code: string;
  status: BinStatus;
  capacity: number;
}

export function validateCreateBin(input: CreateBinInput): ValidatedBin {
  const c = new IssueCollector();
  const bin: ValidatedBin = {
    code: c.requireText("code", input?.code, 32).toUpperCase(),
    status: input?.status === undefined
      ? "AVAILABLE"
      : c.oneOf("status", input.status, BIN_STATUSES, "AVAILABLE"),
    capacity: input?.capacity === undefined ? 100 : c.positiveInteger("capacity", input.capacity),
  };
  c.throwIfInvalid("bin");
  return bin;
}

export function validateBinStatus(value: unknown): BinStatus {
  const c = new IssueCollector();
  const status = c.oneOf("status", value, BIN_STATUSES, "AVAILABLE");
  c.throwIfInvalid("bin status");
  return status;
}

export interface ValidatedBinUpdate {
  status?: BinStatus;
  capacity?: number;
}

/** At least one of status/capacity must be present — an empty patch is a caller mistake, not a no-op. */
export function validateUpdateBin(input: UpdateBinInput): ValidatedBinUpdate {
  const c = new IssueCollector();
  const patch: ValidatedBinUpdate = {};

  if (input?.status !== undefined) {
    patch.status = c.oneOf("status", input.status, BIN_STATUSES, "AVAILABLE");
  }
  if (input?.capacity !== undefined) {
    const capacity = c.optionalPositiveInteger("capacity", input.capacity);
    if (capacity !== null) patch.capacity = capacity;
  }
  if (input?.status === undefined && input?.capacity === undefined) {
    c.add("at least one of status or capacity must be present");
  }

  c.throwIfInvalid("bin update");
  return patch;
}

export interface ValidatedBed {
  bed: number;
  slotCount: number;
}

function validateBedAndSlotCount(input: { bed?: unknown; slotCount?: unknown }, what: string): ValidatedBed {
  const c = new IssueCollector();
  const bed = c.positiveInteger("bed", input?.bed);
  const slotCount = c.positiveInteger("slotCount", input?.slotCount);
  if (slotCount > MAX_SLOTS_PER_REQUEST) {
    c.add(`slotCount must be at most ${MAX_SLOTS_PER_REQUEST}`);
  }
  c.throwIfInvalid(what);
  return { bed, slotCount };
}

export function validateCreateBed(input: CreateBedInput): ValidatedBed {
  return validateBedAndSlotCount(input, "bed");
}

export function validateAddBinsToBed(input: AddBinsToBedInput): ValidatedBed {
  return validateBedAndSlotCount(input, "add-bins-to-bed request");
}

export interface ValidatedInventoryMutation {
  sku: string;
  binCode: string;
  quantity: number;
}

export function validateInventoryMutation(
  input: InventoryMutationInput,
): ValidatedInventoryMutation {
  const c = new IssueCollector();
  const mutation: ValidatedInventoryMutation = {
    sku: c.requireText("sku", input?.sku, 64).toUpperCase(),
    binCode: c.requireText("binCode", input?.binCode, 32).toUpperCase(),
    quantity: c.positiveInteger("quantity", input?.quantity),
  };
  c.throwIfInvalid("inventory mutation");
  return mutation;
}

/** Like validateInventoryMutation, but quantity is a TARGET (0 allowed), not a delta. */
export function validateSetInventoryQuantity(
  input: InventoryMutationInput,
): ValidatedInventoryMutation {
  const c = new IssueCollector();
  const mutation: ValidatedInventoryMutation = {
    sku: c.requireText("sku", input?.sku, 64).toUpperCase(),
    binCode: c.requireText("binCode", input?.binCode, 32).toUpperCase(),
    quantity: c.nonNegativeInteger("quantity", input?.quantity),
  };
  c.throwIfInvalid("inventory adjustment");
  return mutation;
}

export interface ValidatedMovement {
  type: MovementType;
  sku: string;
  quantity: number;
  status: MovementStatus;
  sourceBinCode: string | null;
  destinationBinCode: string | null;
  sourceLocation: string | null;
  destinationLocation: string | null;
}

export function validateCreateMovement(input: CreateMovementInput): ValidatedMovement {
  const c = new IssueCollector();
  const movement: ValidatedMovement = {
    type: c.oneOf("type", input?.type, MOVEMENT_TYPES, "PUTAWAY"),
    sku: c.requireText("sku", input?.sku, 64).toUpperCase(),
    quantity: c.positiveInteger("quantity", input?.quantity),
    status: input?.status === undefined
      ? "PENDING"
      : c.oneOf("status", input.status, MOVEMENT_STATUSES, "PENDING"),
    sourceBinCode: c.optionalText("sourceBinCode", input?.sourceBinCode, 32)?.toUpperCase() ?? null,
    destinationBinCode:
      c.optionalText("destinationBinCode", input?.destinationBinCode, 32)?.toUpperCase() ?? null,
    sourceLocation: c.optionalText("sourceLocation", input?.sourceLocation, 64),
    destinationLocation: c.optionalText("destinationLocation", input?.destinationLocation, 64),
  };

  // A movement that names neither end is not a movement. Bins are optional
  // individually (intake/output stations are free-text locations), but some
  // origin or destination has to be stated.
  const hasSource = movement.sourceBinCode !== null || movement.sourceLocation !== null;
  const hasDestination =
    movement.destinationBinCode !== null || movement.destinationLocation !== null;
  if (!hasSource && !hasDestination) {
    c.add(
      "a movement needs at least one of sourceBinCode/sourceLocation or destinationBinCode/destinationLocation",
    );
  }

  c.throwIfInvalid("movement");
  return movement;
}

export function validateMovementStatus(value: unknown): MovementStatus {
  const c = new IssueCollector();
  const status = c.oneOf("status", value, MOVEMENT_STATUSES, "PENDING");
  c.throwIfInvalid("movement status");
  return status;
}
