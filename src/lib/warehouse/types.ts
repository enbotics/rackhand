/**
 * Shared vocabulary for the authoritative warehouse data layer.
 *
 * SQLite has no native enum type, so the status/type columns in
 * prisma/schema.prisma are plain String. These const tuples are the single
 * source of allowed values: the validation layer checks against them and the
 * derived union types keep the service layer honest at compile time.
 *
 * Nothing here references ScanResult. A scan is an observation; a Part is
 * catalog identity. Milestone 3 owns the mapping between them.
 */

export const BIN_STATUSES = ["AVAILABLE", "RESERVED", "OCCUPIED", "DISABLED"] as const;
export type BinStatus = (typeof BIN_STATUSES)[number];

export const MOVEMENT_TYPES = ["PUTAWAY", "RETRIEVAL", "TRANSFER"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_STATUSES = [
  "PENDING",
  "VALIDATED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

/**
 * Statuses a movement cannot leave. `completedAt` is stamped on entry to one
 * of these — and only ever by an explicit status transition, never as a side
 * effect of creating a movement. A gantry milestone will drive these; this
 * milestone only records what a caller asks for.
 */
export const TERMINAL_MOVEMENT_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
export type TerminalMovementStatus = (typeof TERMINAL_MOVEMENT_STATUSES)[number];

export function isTerminalMovementStatus(status: MovementStatus): status is TerminalMovementStatus {
  return (TERMINAL_MOVEMENT_STATUSES as readonly string[]).includes(status);
}

/** The six MVP bins, seeded by prisma/seed.ts. */
export const SEED_BIN_CODES = ["A01", "A02", "A03", "B01", "B02", "B03"] as const;

export interface CreatePartInput {
  sku: string;
  canonicalName: string;
  category?: string | null;
  description?: string | null;
  lengthMM?: number | null;
  widthMM?: number | null;
  heightMM?: number | null;
}

export interface ListPartsOptions {
  category?: string;
  limit?: number;
}

export interface CreateBinInput {
  code: string;
  status?: BinStatus;
  capacity?: number;
}

/** A part/bin pair addressed by human-facing keys (sku + bin code) or by id. */
export interface InventoryMutationInput {
  sku: string;
  binCode: string;
  quantity: number;
}

export interface CreateMovementInput {
  type: MovementType;
  sku: string;
  quantity: number;
  sourceBinCode?: string | null;
  destinationBinCode?: string | null;
  sourceLocation?: string | null;
  destinationLocation?: string | null;
  /** Optional; defaults to PENDING. A movement is never created COMPLETED. */
  status?: MovementStatus;
}

/** Aggregated stock view for one part across every bin holding it. */
export interface PartInventorySummary {
  part: { id: string; sku: string; canonicalName: string };
  totalQuantity: number;
  locations: Array<{ binCode: string; binStatus: BinStatus; quantity: number }>;
}
