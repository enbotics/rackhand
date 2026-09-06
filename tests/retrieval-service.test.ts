import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { createPart } from "@/lib/warehouse/repository";
import { addInventory, removeInventory } from "@/lib/warehouse/inventory-service";
import { executeRetrieval } from "@/lib/warehouse/retrieval-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { SimulatedGantryController } from "@/lib/gantry/simulator";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 8, like 7, is a state-integrity milestone: most of these assert
 * what did NOT happen. They run against the real database, the real inventory
 * service and the real simulator, with no LLM involved.
 */

const BEARING_6204 = {
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 20mm bore",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};

const simulator = () => getGantryController() as SimulatedGantryController;

async function stockOf(sku: string, binCode: string): Promise<number> {
  const part = await prisma.part.findUnique({ where: { sku } });
  const bin = await prisma.bin.findUnique({ where: { code: binCode } });
  if (!part || !bin) return 0;
  const row = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: part.id, binId: bin.id } },
  });
  return row?.quantity ?? 0;
}

async function binStatus(code: string) {
  return (await prisma.bin.findUnique({ where: { code } }))?.status;
}

async function warehouseState() {
  const [parts, bins, inventory, movements] = await Promise.all([
    prisma.part.findMany({ orderBy: { sku: "asc" } }),
    prisma.bin.findMany({ orderBy: { code: "asc" } }),
    prisma.inventory.findMany({ orderBy: { id: "asc" } }),
    prisma.movement.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { parts, bins, inventory, movements };
}

beforeEach(async () => {
  await resetWarehouse();
  resetGantryController();
  await createPart(BEARING_6204);
});

afterEach(() => {
  // Restore, not delete: deleting would fall back to the 300ms production
  // defaults and slow every later test in this worker.
  process.env.GANTRY_SIM_HOME_DELAY_MS = "0";
  process.env.GANTRY_SIM_MOVE_DELAY_MS = "0";
  resetGantryController();
});

/* ------------------------------------------------------------- happy path */

describe("successful retrieval", () => {
  it("decrements by one and leaves a still-stocked bin OCCUPIED", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-happy" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.part.sku).toBe("BRG-6204");
    expect(result.sourceBinCode).toBe("B03");
    expect(result.destination).toBe("OUTPUT");
    expect(result.inventoryQuantityRemoved).toBe(1);
    expect(result.remainingQuantityInBin).toBe(1);

    expect(await stockOf("BRG-6204", "B03")).toBe(1);
    expect(await binStatus("B03")).toBe("OCCUPIED");

    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId } });
    expect(movement.type).toBe("RETRIEVAL");
    expect(movement.status).toBe("COMPLETED");
    expect(movement.quantity).toBe(1);
    expect(movement.destinationLocation).toBe("OUTPUT");
    expect(movement.completedAt).not.toBeNull();
    expect(movement.gantryOperationId).toBe(result.gantryOperationId);

    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].type).toBe("RETRIEVAL");
    expect(operations[0].status).toBe("COMPLETED");
    expect(operations[0].source).toBe("B03");
    expect(operations[0].destination).toBe("OUTPUT");
  });

  it("frees the bin when the last item leaves", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-last" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remainingQuantityInBin).toBe(0);

    expect(await stockOf("BRG-6204", "B03")).toBe(0);
    expect(await prisma.inventory.count()).toBe(0);
    expect(await binStatus("B03")).toBe("AVAILABLE");
  });

  it("resolves the part by internal id as well as SKU", async () => {
    const part = await prisma.part.findUniqueOrThrow({ where: { sku: "BRG-6204" } });
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });

    const result = await executeRetrieval({ partId: part.id, requestId: "r-byid" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.part.sku).toBe("BRG-6204");
  });
});

/* ------------------------------------------------------ source selection */

describe("source bin selection", () => {
  it("takes from the lowest bin code holding stock", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    await addInventory({ sku: "BRG-6204", binCode: "A02", quantity: 1 });

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-policy" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sourceBinCode).toBe("A02");
    expect(await stockOf("BRG-6204", "A02")).toBe(0);
    expect(await stockOf("BRG-6204", "B03")).toBe(2);
    expect(await binStatus("A02")).toBe("AVAILABLE");
  });

  it("honours an explicit source bin that really holds the part", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "A02", quantity: 1 });
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });

    const result = await executeRetrieval({
      sku: "BRG-6204",
      sourceBinCode: "B03",
      requestId: "r-explicit",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sourceBinCode).toBe("B03");
    expect(await stockOf("BRG-6204", "B03")).toBe(1);
    expect(await stockOf("BRG-6204", "A02")).toBe(1);
  });

  it("rejects an explicit bin that does not hold the part", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const before = await warehouseState();

    const result = await executeRetrieval({
      sku: "BRG-6204",
      sourceBinCode: "A01",
      requestId: "r-mismatch",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_inventory_mismatch");
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("rejects an unknown bin code", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    const result = await executeRetrieval({
      sku: "BRG-6204",
      sourceBinCode: "Z99",
      requestId: "r-nobin",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_bin_not_found");
  });
});

/* ---------------------------------------------------------- request gating */

describe("request validation", () => {
  it("distinguishes an unknown part from having none in stock", async () => {
    const unknown = await executeRetrieval({ sku: "BRG-9999", requestId: "r-unknown" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("part_not_found");

    // Known catalog part, no stock anywhere.
    const empty = await executeRetrieval({ sku: "BRG-6204", requestId: "r-empty" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("out_of_stock");

    expect(await getGantryController().getRecentOperations()).toEqual([]);
    expect(await prisma.movement.count()).toBe(0);
  });

  it("refuses a bulk request outright rather than partly fulfilling it", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 3 });
    const before = await warehouseState();

    const result = await executeRetrieval({ sku: "BRG-6204", quantity: 3, requestId: "r-bulk" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_quantity");
    // Retrieving 1 of 3 is a physical action nobody asked for.
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
    expect(await prisma.movement.count()).toBe(0);
  });

  it("treats an omitted quantity as one", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-implicit" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inventoryQuantityRemoved).toBe(1);
  });

  it("requires exactly one identifier", async () => {
    for (const input of [{}, { sku: "BRG-6204", partId: "abc" }]) {
      const result = await executeRetrieval({ ...input, requestId: `r-${Math.random()}` });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_request");
    }
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });
});

/* --------------------------------------------------------- gantry failures */

describe("gantry failures", () => {
  it("reports gantry_busy without touching inventory", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    process.env.GANTRY_SIM_HOME_DELAY_MS = "300";
    resetGantryController();
    const homing = getGantryController().home();

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-busy" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gantry_busy");
    expect(await stockOf("BRG-6204", "B03")).toBe(2);
    expect(await binStatus("B03")).toBe("OCCUPIED");

    await homing;
  });

  it("leaves the item where it was when pickup fails", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    simulator().failNextOperation("pickup_failed");

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-pickup" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("gantry_failed");
    expect(result.error).toBe("pickup_failed");
    expect(result.sourceBinCode).toBe("B03");

    expect(await stockOf("BRG-6204", "B03")).toBe(2);
    expect(await binStatus("B03")).toBe("OCCUPIED");

    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId! } });
    expect(movement.status).toBe("FAILED");
    expect(movement.idempotencyKey).toBeNull(); // retry allowed
    expect(movement.gantryOperationId).toBe(result.gantryOperationId);
  });

  it("treats a movement timeout as a failure, leaving stock alone", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    simulator().failNextOperation("movement_timeout");

    const result = await executeRetrieval({ sku: "BRG-6204", requestId: "r-timeout" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("movement_timeout");
    expect(await stockOf("BRG-6204", "B03")).toBe(1);
    expect(await binStatus("B03")).toBe("OCCUPIED");
  });
});

/* ------------------------------------------------------------ idempotency */

describe("idempotency", () => {
  it("does not retrieve twice for one request id", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });

    const first = await executeRetrieval({ sku: "BRG-6204", requestId: "r-dup" });
    const second = await executeRetrieval({ sku: "BRG-6204", requestId: "r-dup" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.duplicate).toBe(true);
    expect(second.inventoryQuantityRemoved).toBe(0);
    expect(second.movementId).toBe(first.movementId);
    expect(second.gantryOperationId).toBe(first.gantryOperationId);

    expect(await stockOf("BRG-6204", "B03")).toBe(1); // never 0
    expect(await prisma.movement.count()).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });

  it("runs the gantry once for concurrent duplicates of one request id", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });

    const results = await Promise.all([
      executeRetrieval({ sku: "BRG-6204", requestId: "r-race-dup" }),
      executeRetrieval({ sku: "BRG-6204", requestId: "r-race-dup" }),
    ]);

    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect(await stockOf("BRG-6204", "B03")).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });

  it("allows a retry after a failure", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    simulator().failNextOperation("drop_failed");

    const first = await executeRetrieval({ sku: "BRG-6204", requestId: "r-retry" });
    expect(first.ok).toBe(false);

    const second = await executeRetrieval({ sku: "BRG-6204", requestId: "r-retry" });
    expect(second.ok).toBe(true);
    expect(await stockOf("BRG-6204", "B03")).toBe(0);
    expect(await prisma.movement.count()).toBe(2); // failed attempt kept
  });
});

/* ------------------------------------------------------------ concurrency */

describe("concurrent retrieval of the last item", () => {
  it("cannot drive stock negative", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });

    const [a, b] = await Promise.all([
      executeRetrieval({ sku: "BRG-6204", requestId: "r-conc-a" }),
      executeRetrieval({ sku: "BRG-6204", requestId: "r-conc-b" }),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const failed = [a, b].find((r) => !r.ok) as { reason: string };
    // Whichever guard fires first — the gantry mutex, the fresh inventory read,
    // or the conditional decrement — stock is never negative.
    expect([
      "gantry_busy",
      "out_of_stock",
      "inventory_conflict",
      "retrieval_commit_failed",
    ]).toContain(failed.reason);

    expect(await stockOf("BRG-6204", "B03")).toBe(0);
    const quantities = (await prisma.inventory.findMany()).map((r) => r.quantity);
    expect(quantities.every((q) => q >= 0)).toBe(true);
  });
});

/* ------------------------------------------- commit failure after success */

describe("database commit failure after the gantry succeeded", () => {
  it("does not re-run the gantry and preserves ids for reconciliation", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });

    // A real commit failure: the stock is removed by another path while the
    // gantry is mid-operation, so the conditional decrement finds nothing.
    process.env.GANTRY_SIM_MOVE_DELAY_MS = "400";
    resetGantryController();

    const pending = executeRetrieval({ sku: "BRG-6204", requestId: "r-commit" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await removeInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });

    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("retrieval_commit_failed");
    expect(result.movementId).toBeDefined();
    expect(result.gantryOperationId).toBeDefined();
    expect(result.sourceBinCode).toBe("B03");
    expect(result.partId).toBeDefined();

    // The gantry ran exactly once and reported success.
    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("COMPLETED");

    // The movement is not falsely COMPLETED, and stock never went negative.
    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId! } });
    expect(movement.status).toBe("RUNNING");
    expect(movement.completedAt).toBeNull();
    expect(await stockOf("BRG-6204", "B03")).toBe(0);
  });
});
