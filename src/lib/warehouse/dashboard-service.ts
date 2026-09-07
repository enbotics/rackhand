/**
 * Composes the authoritative warehouse snapshot the dashboard renders
 * (Milestone 10).
 *
 * READ ONLY. Nothing here creates, updates or deletes a row, and it holds no
 * business rules of its own: no availability decision, no quantity
 * arithmetic beyond summing what the database already stores, no matching, no
 * reservation. Deciding what may happen to a bin stays in the putaway and
 * retrieval services where the transactions are; this only reports what IS.
 *
 * It exists so the browser never has to join Inventory to Part to Bin itself.
 * A React component that did those joins would be a second, silent
 * implementation of warehouse state, and the moment it disagreed with the
 * database the operator would be looking at a warehouse that does not exist.
 */
import { prisma } from "./db";
import type {
  BinView,
  InventoryRowView,
  MovementRowView,
  WarehouseOverview,
} from "./dashboard-types";
import type { BinStatus, MovementStatus, MovementType } from "./types";

/** Enough history to read the last few operations at a glance, not an audit log. */
export const DEFAULT_MOVEMENT_LIMIT = 8;
const MAX_MOVEMENT_LIMIT = 50;

function clampMovementLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_MOVEMENT_LIMIT;
  return Math.min(limit, MAX_MOVEMENT_LIMIT);
}

/**
 * Most-recent-first per (partId, binId) pair, from COMPLETED putaways that
 * actually captured a photo. One extra query, done once for the whole
 * overview rather than per bin — the alternative is an N+1 lookup.
 */
async function loadPutawayImages(): Promise<Map<string, string>> {
  const rows = await prisma.movement.findMany({
    where: { type: "PUTAWAY", status: "COMPLETED", imageUrl: { not: null } },
    orderBy: { completedAt: "desc" },
    select: { partId: true, destinationBinId: true, imageUrl: true },
  });
  const byPartBin = new Map<string, string>();
  for (const row of rows) {
    if (!row.destinationBinId || !row.imageUrl) continue;
    const key = `${row.partId}:${row.destinationBinId}`;
    // Ordered by completedAt desc, so the first write for a key IS the latest.
    if (!byPartBin.has(key)) byPartBin.set(key, row.imageUrl);
  }
  return byPartBin;
}

export async function getWarehouseOverview(movementLimit?: number): Promise<WarehouseOverview> {
  const [bins, inventoryRows, movements, putawayImages] = await Promise.all([
    prisma.bin.findMany({
      orderBy: { code: "asc" },
      include: { inventory: { include: { part: true }, orderBy: { part: { sku: "asc" } } } },
    }),
    prisma.inventory.findMany({
      include: { part: true, bin: true },
      orderBy: [{ part: { sku: "asc" } }, { bin: { code: "asc" } }],
    }),
    prisma.movement.findMany({
      orderBy: { createdAt: "desc" },
      take: clampMovementLimit(movementLimit),
      include: { part: true, sourceBin: true, destinationBin: true },
    }),
    loadPutawayImages(),
  ]);

  const binViews: BinView[] = bins.map((bin) => {
    const contents = bin.inventory
      // A zero row is bookkeeping left behind by a retrieval, not stock. It
      // must not draw a part into a bin that is physically empty.
      .filter((row) => row.quantity > 0)
      .map((row) => ({
        partId: row.partId,
        sku: row.part.sku,
        canonicalName: row.part.canonicalName,
        quantity: row.quantity,
        imageUrl: putawayImages.get(`${row.partId}:${bin.id}`) ?? null,
      }));

    return {
      binId: bin.id,
      code: bin.code,
      // The Bin row's own status, verbatim. Never derived from `contents`.
      status: bin.status as BinStatus,
      capacity: bin.capacity,
      contents,
      totalQuantity: contents.reduce((sum, item) => sum + item.quantity, 0),
    };
  });

  // Grouped by part so one SKU spread over several bins reads as one line
  // ("Qty 3 — B1-02 (1), B2-01 (2)") rather than as several unrelated rows.
  const byPart = new Map<string, InventoryRowView>();
  for (const row of inventoryRows) {
    if (row.quantity <= 0) continue;
    const existing = byPart.get(row.partId);
    if (existing) {
      existing.totalQuantity += row.quantity;
      existing.locations.push({ binCode: row.bin.code, quantity: row.quantity });
      continue;
    }
    byPart.set(row.partId, {
      partId: row.partId,
      sku: row.part.sku,
      canonicalName: row.part.canonicalName,
      category: row.part.category,
      totalQuantity: row.quantity,
      locations: [{ binCode: row.bin.code, quantity: row.quantity }],
    });
  }
  const inventory = [...byPart.values()];

  const movementViews: MovementRowView[] = movements.map((movement) => ({
    id: movement.id,
    type: movement.type as MovementType,
    status: movement.status as MovementStatus,
    sku: movement.part.sku,
    canonicalName: movement.part.canonicalName,
    quantity: movement.quantity,
    // A bin if there is one, otherwise the free-text station (INTAKE/OUTPUT).
    source: movement.sourceBin?.code ?? movement.sourceLocation,
    destination: movement.destinationBin?.code ?? movement.destinationLocation,
    createdAt: movement.createdAt.getTime(),
    completedAt: movement.completedAt?.getTime() ?? null,
  }));

  return {
    generatedAt: Date.now(),
    bins: binViews,
    inventory,
    movements: movementViews,
    totals: {
      units: inventory.reduce((sum, row) => sum + row.totalQuantity, 0),
      distinctParts: inventory.length,
      binsAvailable: binViews.filter((bin) => bin.status === "AVAILABLE").length,
      binsOccupied: binViews.filter((bin) => bin.status === "OCCUPIED").length,
    },
  };
}
