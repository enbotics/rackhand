/**
 * Inventory quantity changes — the one place warehouse stock moves.
 *
 * Every mutation runs inside a Prisma interactive transaction, and the actual
 * quantity change is a single conditional UPDATE (`updateMany` with the
 * quantity guard in the WHERE clause) rather than read-quantity → compute →
 * write-later. That makes "never negative" and "never over capacity"
 * properties of the write itself: if the guard does not match, zero rows
 * change and the service reports why. This matters more once a gantry is
 * issuing concurrent operations.
 *
 * Bin occupancy is kept in step with stock in the same transaction: a bin
 * flips AVAILABLE -> OCCUPIED when it gains stock and back when it empties.
 * RESERVED and DISABLED bins are never re-labelled automatically — those are
 * deliberate operator states.
 */
import { prisma } from "./db";
import { WarehouseError } from "./errors";
import { requireBinByCode, requirePartBySku } from "./repository";
import type { BinStatus, InventoryMutationInput, PartInventorySummary } from "./types";
import { validateInventoryMutation, validateSetInventoryQuantity } from "./validation";
import type { Inventory, Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient;

/** An inventory row plus the human-facing keys callers actually think in. */
export interface InventoryRecord {
  id: string;
  sku: string;
  binCode: string;
  quantity: number;
}

async function toRecord(db: Db, row: Inventory): Promise<InventoryRecord> {
  const [part, bin] = await Promise.all([
    db.part.findUnique({ where: { id: row.partId } }),
    db.bin.findUnique({ where: { id: row.binId } }),
  ]);
  return {
    id: row.id,
    sku: part?.sku ?? "",
    binCode: bin?.code ?? "",
    quantity: row.quantity,
  };
}

/** AVAILABLE -> OCCUPIED when a bin gains its first stock. */
async function markBinOccupied(db: Db, binId: string, status: string): Promise<void> {
  if (status === "AVAILABLE") {
    await db.bin.update({ where: { id: binId }, data: { status: "OCCUPIED" } });
  }
}

/** OCCUPIED -> AVAILABLE once the last unit leaves a bin. */
async function releaseBinIfEmpty(db: Db, binId: string, status: string): Promise<void> {
  if (status !== "OCCUPIED") return;
  const remaining = await db.inventory.count({ where: { binId } });
  if (remaining === 0) {
    await db.bin.update({ where: { id: binId }, data: { status: "AVAILABLE" } });
  }
}

/**
 * Adds stock of one part to one bin, creating the inventory row on first use.
 *
 * Enforces the MVP's one-SKU-per-bin rule: a bin already holding a different
 * part is an inventory_conflict, not a silent mixed-SKU bin.
 */
export async function addInventory(input: InventoryMutationInput): Promise<InventoryRecord> {
  const { sku, binCode, quantity } = validateInventoryMutation(input);

  return prisma.$transaction(async (tx) => {
    const part = await requirePartBySku(sku, tx);
    const bin = await requireBinByCode(binCode, tx);
    return applyInventoryAddition(tx, part, bin, quantity);
  });
}

/**
 * The stock-increase itself, inside a caller-supplied transaction.
 *
 * Extracted so an orchestrating service (Milestone 7 putaway) can commit an
 * inventory change together with a bin status and a movement status in ONE
 * transaction. Prisma forbids nesting `$transaction`, so calling addInventory
 * from inside another transaction is impossible — and duplicating these guards
 * would mean two places that must agree about capacity, one-SKU-per-bin and
 * DISABLED bins. There is one implementation; addInventory is the standalone
 * wrapper around it.
 *
 * Quantity is assumed already validated by the caller.
 */
export async function applyInventoryAddition(
  tx: Db,
  part: { id: string; sku: string },
  bin: { id: string; code: string; status: string; capacity: number },
  quantity: number,
): Promise<InventoryRecord> {
  {
    if (bin.status === "DISABLED") {
      throw new WarehouseError("bin_unavailable", `Bin "${bin.code}" is DISABLED and cannot take stock.`);
    }

    const occupant = await tx.inventory.findFirst({ where: { binId: bin.id } });
    if (occupant && occupant.partId !== part.id) {
      throw new WarehouseError(
        "inventory_conflict",
        `Bin "${bin.code}" already holds a different part — this warehouse stores one SKU per bin.`,
      );
    }

    if (!occupant) {
      if (quantity > bin.capacity) {
        throw new WarehouseError(
          "bin_capacity_exceeded",
          `Bin "${bin.code}" holds at most ${bin.capacity} units; tried to add ${quantity}.`,
        );
      }
      const created = await tx.inventory.create({
        data: { partId: part.id, binId: bin.id, quantity },
      });
      await markBinOccupied(tx, bin.id, bin.status);
      return toRecord(tx, created);
    }

    // Conditional increment: only applies while the result stays within
    // capacity, so a concurrent add cannot overfill the bin between the
    // check and the write.
    const updated = await tx.inventory.updateMany({
      where: { id: occupant.id, quantity: { lte: bin.capacity - quantity } },
      data: { quantity: { increment: quantity } },
    });
    if (updated.count !== 1) {
      throw new WarehouseError(
        "bin_capacity_exceeded",
        `Bin "${bin.code}" holds at most ${bin.capacity} units; it already has ${occupant.quantity} and cannot take ${quantity} more.`,
      );
    }

    await markBinOccupied(tx, bin.id, bin.status);
    const row = await tx.inventory.findUniqueOrThrow({ where: { id: occupant.id } });
    return toRecord(tx, row);
  }
}

/**
 * Removes stock. Rejects any request that would drive the quantity below
 * zero; the row is deleted when it reaches exactly zero so the bin can hold a
 * different SKU next time.
 */
export async function removeInventory(input: InventoryMutationInput): Promise<InventoryRecord> {
  const { sku, binCode, quantity } = validateInventoryMutation(input);

  return prisma.$transaction(async (tx) => {
    const part = await requirePartBySku(sku, tx);
    const bin = await requireBinByCode(binCode, tx);
    return applyInventoryRemoval(tx, part, bin, quantity);
  });
}

/**
 * The stock-decrease itself, inside a caller-supplied transaction.
 *
 * The counterpart to applyInventoryAddition, extracted for the same reason:
 * Milestone 8 retrieval must decrement stock, free the bin and complete the
 * movement in ONE transaction, and Prisma forbids nesting `$transaction`.
 * Duplicating the `gte` guard would mean two places that must agree about how
 * "never negative" is enforced.
 *
 * Quantity is assumed already validated by the caller.
 */
export async function applyInventoryRemoval(
  tx: Db,
  part: { id: string; sku: string },
  bin: { id: string; code: string; status: string },
  quantity: number,
): Promise<InventoryRecord> {
  {
    const existing = await tx.inventory.findUnique({
      where: { partId_binId: { partId: part.id, binId: bin.id } },
    });
    if (!existing) {
      throw new WarehouseError(
        "inventory_not_found",
        `Bin "${bin.code}" holds no stock of "${part.sku}".`,
      );
    }

    // Conditional decrement — the `gte` guard is what makes a negative
    // quantity unrepresentable, rather than a check that could go stale.
    const updated = await tx.inventory.updateMany({
      where: { id: existing.id, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    if (updated.count !== 1) {
      throw new WarehouseError(
        "insufficient_inventory",
        `Bin "${bin.code}" holds ${existing.quantity} of "${part.sku}"; cannot remove ${quantity}.`,
      );
    }

    const row = await tx.inventory.findUniqueOrThrow({ where: { id: existing.id } });
    const result: InventoryRecord = {
      id: row.id,
      sku: part.sku,
      binCode: bin.code,
      quantity: row.quantity,
    };

    if (row.quantity === 0) {
      await tx.inventory.delete({ where: { id: row.id } });
    }
    await releaseBinIfEmpty(tx, bin.id, bin.status);

    return result;
  }
}

/**
 * Direct operator override from the bin-detail modal: "this bin actually has
 * N units," not "add/remove N." Reuses applyInventoryAddition/Removal for the
 * actual write — every capacity/negative/one-SKU-per-bin guard those already
 * enforce applies here too, unchanged — and additionally records an
 * ADJUSTMENT Movement with the exact before/after for an honest audit trail,
 * in the same transaction as the quantity change itself.
 */
export async function setInventoryQuantity(
  input: InventoryMutationInput,
): Promise<InventoryRecord> {
  const { sku, binCode, quantity: newQuantity } = validateSetInventoryQuantity(input);

  return prisma.$transaction(async (tx) => {
    const part = await requirePartBySku(sku, tx);
    const bin = await requireBinByCode(binCode, tx);
    const existing = await tx.inventory.findUnique({
      where: { partId_binId: { partId: part.id, binId: bin.id } },
    });
    const previousQuantity = existing?.quantity ?? 0;
    const delta = newQuantity - previousQuantity;

    if (delta === 0) {
      throw new WarehouseError(
        "validation_failed",
        `Bin "${bin.code}" already holds ${previousQuantity} of "${part.sku}" — nothing to adjust.`,
      );
    }

    const record =
      delta > 0
        ? await applyInventoryAddition(tx, part, bin, delta)
        : await applyInventoryRemoval(tx, part, bin, Math.abs(delta));

    await tx.movement.create({
      data: {
        type: "ADJUSTMENT",
        partId: part.id,
        quantity: Math.abs(delta),
        status: "COMPLETED",
        destinationBinId: bin.id,
        previousQuantity,
        newQuantity,
        completedAt: new Date(),
      },
    });

    return record;
  });
}

/** Aggregated stock for one SKU across every bin holding it. */
export async function getInventoryForPart(sku: string): Promise<PartInventorySummary> {
  const part = await requirePartBySku(sku);
  const rows = await prisma.inventory.findMany({
    where: { partId: part.id },
    include: { bin: true },
    orderBy: { bin: { code: "asc" } },
  });

  return {
    part: { id: part.id, sku: part.sku, canonicalName: part.canonicalName },
    totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    locations: rows.map((row) => ({
      binCode: row.bin.code,
      binStatus: row.bin.status as BinStatus,
      quantity: row.quantity,
    })),
  };
}

/** Everything stored in one bin. One SKU per bin, so at most one row today. */
export async function getInventoryByBin(binCode: string): Promise<InventoryRecord[]> {
  const bin = await requireBinByCode(binCode);
  const rows = await prisma.inventory.findMany({
    where: { binId: bin.id },
    include: { part: true },
    orderBy: { part: { sku: "asc" } },
  });
  return rows.map((row) => ({
    id: row.id,
    sku: row.part.sku,
    binCode: bin.code,
    quantity: row.quantity,
  }));
}

export async function listInventory(): Promise<InventoryRecord[]> {
  const rows = await prisma.inventory.findMany({
    include: { part: true, bin: true },
    orderBy: [{ bin: { code: "asc" } }, { part: { sku: "asc" } }],
  });
  return rows.map((row) => ({
    id: row.id,
    sku: row.part.sku,
    binCode: row.bin.code,
    quantity: row.quantity,
  }));
}
