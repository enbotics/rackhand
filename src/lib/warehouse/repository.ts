/**
 * Catalog, bin and movement access for the authoritative warehouse database.
 *
 * Route handlers (and, later, Strands tools) call these functions rather than
 * touching Prisma directly, so validation and warehouse error codes are
 * applied in exactly one place. Inventory quantity changes live in
 * inventory-service.ts because they need transactions.
 */
import { prisma } from "./db";
import { WarehouseError, isUniqueConstraintError } from "./errors";
import {
  isTerminalMovementStatus,
  type BinStatus,
  type CreateBinInput,
  type CreateMovementInput,
  type CreatePartInput,
  type ListPartsOptions,
  type MovementStatus,
} from "./types";
import {
  validateCreateBin,
  validateCreateMovement,
  validateCreatePart,
  validateMovementStatus,
} from "./validation";
import type { Bin, Movement, Part, Prisma } from "@/generated/prisma/client";

/** Any Prisma client — the shared one, or a transaction-scoped one. */
type Db = Prisma.TransactionClient | typeof prisma;

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 100;

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return fallback;
  return Math.min(limit, MAX_LIST_LIMIT);
}

/* ------------------------------------------------------------------ catalog */

export async function createPart(input: CreatePartInput): Promise<Part> {
  const data = validateCreatePart(input);
  try {
    return await prisma.part.create({ data });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new WarehouseError("duplicate_sku", `A part with SKU "${data.sku}" already exists.`);
    }
    throw err;
  }
}

export async function getPartById(id: string): Promise<Part | null> {
  if (typeof id !== "string" || id.trim() === "") return null;
  return prisma.part.findUnique({ where: { id: id.trim() } });
}

export async function getPartBySku(sku: string): Promise<Part | null> {
  if (typeof sku !== "string" || sku.trim() === "") return null;
  return prisma.part.findUnique({ where: { sku: sku.trim().toUpperCase() } });
}

/** Same lookup as getPartBySku, but a miss is a warehouse error, not null. */
export async function requirePartBySku(sku: string, db: Db = prisma): Promise<Part> {
  const normalized = typeof sku === "string" ? sku.trim().toUpperCase() : "";
  const part = normalized ? await db.part.findUnique({ where: { sku: normalized } }) : null;
  if (!part) {
    throw new WarehouseError("part_not_found", `No catalog part with SKU "${normalized}".`);
  }
  return part;
}

export async function listParts(options: ListPartsOptions = {}): Promise<Part[]> {
  const category = options.category?.trim();
  return prisma.part.findMany({
    where: category ? { category } : undefined,
    orderBy: { sku: "asc" },
    take: clampLimit(options.limit),
  });
}

/* --------------------------------------------------------------------- bins */

export async function createBin(input: CreateBinInput): Promise<Bin> {
  const data = validateCreateBin(input);
  try {
    return await prisma.bin.create({ data });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new WarehouseError("duplicate_bin_code", `A bin with code "${data.code}" already exists.`);
    }
    throw err;
  }
}

export async function getBinByCode(code: string): Promise<Bin | null> {
  if (typeof code !== "string" || code.trim() === "") return null;
  return prisma.bin.findUnique({ where: { code: code.trim().toUpperCase() } });
}

export async function requireBinByCode(code: string, db: Db = prisma): Promise<Bin> {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  const bin = normalized ? await db.bin.findUnique({ where: { code: normalized } }) : null;
  if (!bin) {
    throw new WarehouseError("bin_not_found", `No bin with code "${normalized}".`);
  }
  return bin;
}

export async function listBins(): Promise<Bin[]> {
  return prisma.bin.findMany({ orderBy: { code: "asc" } });
}

/**
 * What "available for putaway" means, in one place. RESERVED, OCCUPIED and
 * DISABLED bins are all excluded — reserved and disabled are deliberate
 * operator states, and occupied bins already hold a SKU.
 */
const AVAILABLE_BIN_WHERE = { status: "AVAILABLE" } as const;

/**
 * Deterministic allocation for the MVP: the first AVAILABLE bin by code.
 * Intentionally not AI-driven — smarter allocation belongs to a later
 * milestone.
 */
export async function findAvailableBin(db: Db = prisma): Promise<Bin | null> {
  return db.bin.findFirst({
    where: AVAILABLE_BIN_WHERE,
    orderBy: { code: "asc" },
  });
}

/**
 * Every bin currently eligible for a future putaway, by the same rule
 * findAvailableBin uses to pick one.
 *
 * READ-ONLY: listing eligibility is not allocation. Nothing here reserves a
 * bin or changes a status — reservation belongs to a later milestone.
 */
export async function listAvailableBins(db: Db = prisma): Promise<Bin[]> {
  return db.bin.findMany({
    where: AVAILABLE_BIN_WHERE,
    orderBy: { code: "asc" },
  });
}

export async function setBinStatus(code: string, status: BinStatus): Promise<Bin> {
  const bin = await requireBinByCode(code);
  return prisma.bin.update({ where: { id: bin.id }, data: { status } });
}

/* ---------------------------------------------------------------- movements */

/**
 * Records an intended warehouse transition. This does NOT move anything and
 * does NOT touch inventory quantities — a movement is a request, and its
 * physical lifecycle belongs to the gantry milestone. Creating one as
 * COMPLETED is rejected for exactly that reason.
 */
export async function createMovement(input: CreateMovementInput): Promise<Movement> {
  const data = validateCreateMovement(input);

  if (isTerminalMovementStatus(data.status)) {
    throw new WarehouseError(
      "invalid_status_transition",
      `A movement cannot be created as ${data.status} — it must start in a non-terminal status and be transitioned explicitly.`,
    );
  }

  const part = await requirePartBySku(data.sku);
  const sourceBin = data.sourceBinCode ? await requireBinByCode(data.sourceBinCode) : null;
  const destinationBin = data.destinationBinCode
    ? await requireBinByCode(data.destinationBinCode)
    : null;

  return prisma.movement.create({
    data: {
      type: data.type,
      partId: part.id,
      quantity: data.quantity,
      status: data.status,
      sourceBinId: sourceBin?.id ?? null,
      destinationBinId: destinationBin?.id ?? null,
      sourceLocation: data.sourceLocation,
      destinationLocation: data.destinationLocation,
    },
  });
}

export async function getMovement(id: string): Promise<Movement | null> {
  if (typeof id !== "string" || id.trim() === "") return null;
  return prisma.movement.findUnique({ where: { id: id.trim() } });
}

/**
 * Moves a movement to another status. `completedAt` is stamped only on entry
 * to a terminal status, and a terminal movement is frozen — nothing may
 * quietly re-open or re-complete a finished record.
 */
export async function updateMovementStatus(id: string, status: MovementStatus): Promise<Movement> {
  const nextStatus = validateMovementStatus(status);
  const existing = await getMovement(id);
  if (!existing) {
    throw new WarehouseError("movement_not_found", `No movement with id "${id}".`);
  }

  const currentStatus = existing.status as MovementStatus;
  if (isTerminalMovementStatus(currentStatus)) {
    throw new WarehouseError(
      "invalid_status_transition",
      `Movement "${id}" is already ${currentStatus} and cannot change status.`,
    );
  }
  if (currentStatus === nextStatus) return existing;

  return prisma.movement.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      completedAt: isTerminalMovementStatus(nextStatus) ? new Date() : null,
    },
  });
}

export async function listRecentMovements(limit?: number): Promise<Movement[]> {
  return prisma.movement.findMany({
    orderBy: { createdAt: "desc" },
    take: clampLimit(limit, 50),
  });
}
