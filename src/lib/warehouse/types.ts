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

/**
 * THE PHYSICAL SHELF, as built.
 *
 * The rack has two bays. One is the workstation: the camera scans a part
 * there, and it is where every part arrives from and leaves to. That bay is
 * NOT storage — it is the INTAKE and OUTPUT stations in src/lib/gantry/types.ts,
 * and it is deliberately not represented here, so bin-availability logic can
 * never treat the scan table as somewhere stock can live.
 *
 * The other bay is storage: six beds (shelf levels), five bin boxes across
 * each, thirty in all. A bin box is 4" wide and 12" deep, so a slot is one
 * box-width along a bed.
 *
 *      bed 6   B6-01  B6-02  B6-03  B6-04  B6-05
 *      bed 5   B5-01  B5-02  B5-03  B5-04  B5-05
 *      bed 4   B4-01  ...
 *      bed 3   B3-01
 *      bed 2   B2-01
 *      bed 1   B1-01  B1-02  B1-03  B1-04  B1-05
 *
 * THE CODE IS THE POSITION. `B4-02` is bed 4, slot 2, which is what makes a
 * gantry coordinate a parse rather than a hand-maintained lookup table — bed
 * chooses the vertical axis, slot the horizontal one. Nothing in this
 * milestone moves real hardware; this is the vocabulary that milestone will
 * use. Codes sort into physical order, so the deterministic "lowest available
 * bin" policy fills the bottom bed left-to-right before climbing.
 */
/**
 * The SEED layout only — how many beds/slots `prisma/seed.ts` creates on a
 * fresh database, and the UI's default slot count when creating a new bed.
 * NOT a validation ceiling: the warehouse now grows bins/beds at runtime (bin
 * management CRUD), so a bed number or slot count beyond these is legitimate.
 * Whether a given bed/slot actually exists is a database question, not a
 * question this constant can answer.
 */
export const STORAGE_BEDS = 6;
export const SLOTS_PER_BED = 5;

/**
 * Was a closed template-literal union (`B${1-6}-${01-05}`), which caught a
 * typo'd bin code at compile time. That guarantee only holds for a fixed
 * layout — now that beds/bins are created and deleted at runtime, the set of
 * valid codes is a database fact, not something the type system can enumerate
 * in advance. A bin code is validated at runtime instead (parseBinCode below,
 * plus a real lookup wherever "does this bin exist" matters).
 */
export type BinCode = string;

function buildBinCodes(): BinCode[] {
  const codes: BinCode[] = [];
  for (let bed = 1; bed <= STORAGE_BEDS; bed += 1) {
    for (let slot = 1; slot <= SLOTS_PER_BED; slot += 1) {
      codes.push(`B${bed}-${String(slot).padStart(2, "0")}`);
    }
  }
  return codes;
}

/** The seed layout's bins (see STORAGE_BEDS/SLOTS_PER_BED above). Physical order. */
export const SEED_BIN_CODES: readonly BinCode[] = buildBinCodes();

/**
 * `B4-02` -> `{ bed: 4, slot: 2 }`. Null for anything that isn't SHAPED like a
 * bin code. Does not check the bed/slot actually exists — that's a database
 * lookup, not a parsing concern (see repository.ts's bed/bin functions).
 */
export function parseBinCode(code: string): { bed: number; slot: number } | null {
  const match = /^B(\d+)-(\d{2})$/.exec(code.trim().toUpperCase());
  if (!match) return null;
  const bed = Number(match[1]);
  const slot = Number(match[2]);
  if (bed < 1 || slot < 1) return null;
  return { bed, slot };
}

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

/** At least one field must be present — enforced by validateUpdateBin, not by this type. */
export interface UpdateBinInput {
  status?: BinStatus;
  capacity?: number;
}

/** Creates a brand-new bed: slots 01..slotCount, all AVAILABLE. Fails if the bed already has bins. */
export interface CreateBedInput {
  bed: number;
  slotCount: number;
}

/** Appends slotCount more bins after the bed's current highest slot. Fails if the bed has none yet. */
export interface AddBinsToBedInput {
  bed: number;
  slotCount: number;
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
