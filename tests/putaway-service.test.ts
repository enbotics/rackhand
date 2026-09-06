import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { createPart, setBinStatus } from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { executePutaway } from "@/lib/warehouse/putaway-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { SimulatedGantryController } from "@/lib/gantry/simulator";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 7 is a state-integrity milestone, so most of these tests assert
 * what did NOT happen: no gantry operation, no inventory row, no bin left
 * reserved. They run against the real database, the real matcher and the real
 * simulator, with no LLM involved — the service must be correct on its own.
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

const BOLT_HEX = {
  sku: "BOLT-M8-50",
  canonicalName: "M8 x 50 Hex Bolt",
  category: "fastener",
  description: "Zinc-plated steel hex head bolt",
  lengthMM: 50,
  widthMM: 13,
  heightMM: 5.3,
};

const BOLT_FLANGE = {
  sku: "BOLT-M8-50-FLG",
  canonicalName: "M8 x 50 Flange Bolt",
  category: "fastener",
  description: "Zinc-plated steel flange head bolt",
  lengthMM: 50,
  widthMM: 14,
  heightMM: 5.3,
};

/** A scan that matches BRG-6204 unless overridden. */
function scanOf(overrides: Partial<{
  scanId: string;
  detectedName: string;
  description: string;
  lengthMM: number;
  widthMM: number;
  heightMM: number | null;
}> = {}): ScanResult {
  return {
    scanId: overrides.scanId ?? "scan_1788574200123_a1b2c3",
    capturedAt: 1788574200123,
    object: {
      detectedName: overrides.detectedName ?? "6204 bearing",
      description: overrides.description ?? "Metal circular bearing with visible races.",
    },
    dimensions: {
      lengthMM: overrides.lengthMM ?? 47.2,
      widthMM: overrides.widthMM ?? 46.9,
      heightMM: overrides.heightMM === undefined ? 14.1 : overrides.heightMM,
    },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

const simulator = () => getGantryController() as SimulatedGantryController;

async function warehouseState() {
  const [parts, bins, inventory, movements] = await Promise.all([
    prisma.part.findMany({ orderBy: { sku: "asc" } }),
    prisma.bin.findMany({ orderBy: { code: "asc" } }),
    prisma.inventory.findMany({ orderBy: { id: "asc" } }),
    prisma.movement.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { parts, bins, inventory, movements };
}

async function binStatus(code: string) {
  return (await prisma.bin.findUnique({ where: { code } }))?.status;
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
  resetGantryController();
});

/* ------------------------------------------------------------- happy path */

describe("successful putaway", () => {
  it("commits inventory, occupies the bin and completes the movement", async () => {
    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.part.sku).toBe("BRG-6204");
    expect(result.destinationBinCode).toBe("B03");
    expect(result.inventoryQuantityAdded).toBe(1);
    expect(result.status).toBe("COMPLETED");
    expect(result.gantryOperationId).toMatch(/^gantry_/);

    // Inventory
    const inventory = await prisma.inventory.findMany({ include: { bin: true, part: true } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].quantity).toBe(1);
    expect(inventory[0].bin.code).toBe("B03");
    expect(inventory[0].part.sku).toBe("BRG-6204");

    // Bin
    expect(await binStatus("B03")).toBe("OCCUPIED");

    // Movement
    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId } });
    expect(movement.status).toBe("COMPLETED");
    expect(movement.type).toBe("PUTAWAY");
    expect(movement.quantity).toBe(1);
    expect(movement.sourceLocation).toBe("INTAKE");
    expect(movement.completedAt).not.toBeNull();
    expect(movement.scanId).toBe("scan_1788574200123_a1b2c3");
    expect(movement.gantryOperationId).toBe(result.gantryOperationId);

    // Exactly one machine operation, and it succeeded.
    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("COMPLETED");
    expect(operations[0].type).toBe("PUTAWAY");
    expect(operations[0].source).toBe("INTAKE");
    expect(operations[0].destination).toBe("B03");
  });

  it("picks the first available bin by code when no destination is given", async () => {
    const result = await executePutaway({ scanResult: scanOf() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // findAvailableBin policy: first AVAILABLE ordered by code.
    expect(result.destinationBinCode).toBe("A01");
  });

  it("skips bins that are not AVAILABLE when choosing automatically", async () => {
    await setBinStatus("A01", "DISABLED");
    await setBinStatus("A02", "RESERVED");

    const result = await executePutaway({ scanResult: scanOf() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.destinationBinCode).toBe("A03");
  });
});

/* --------------------------------------------------------- match refusals */

describe("catalog match gating", () => {
  it("refuses an AMBIGUOUS match without touching anything", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const before = await warehouseState();

    const result = await executePutaway({
      scanResult: scanOf({
        detectedName: "M8 bolt",
        description: "Steel hex bolt",
        lengthMM: 50.1,
        widthMM: 13.5,
        heightMM: 5.3,
      }),
      destinationBinCode: "B03",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("catalog_match_ambiguous");
    expect(result.candidates?.length).toBeGreaterThan(1);
    expect(result.movementId).toBeUndefined();

    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("refuses NO_MATCH and creates no Part", async () => {
    const before = await warehouseState();

    const result = await executePutaway({
      scanResult: scanOf({
        detectedName: "rubber duck",
        description: "Yellow moulded toy",
        lengthMM: 90,
        widthMM: 70,
        heightMM: 80,
      }),
      destinationBinCode: "B03",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("catalog_no_match");

    expect(await warehouseState()).toEqual(before);
    expect(await prisma.part.count()).toBe(1); // only the one we seeded
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("refuses a structurally invalid scan before doing anything", async () => {
    const before = await warehouseState();
    const result = await executePutaway({
      scanResult: { scanId: "scan_x", capturedAt: 1 } as unknown as ScanResult,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_scan");
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });
});

/* ------------------------------------------------------------ bin gating */

describe("destination validation", () => {
  it("rejects an occupied bin and never starts the gantry", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    const before = await warehouseState();

    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bin_unavailable");
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("rejects a RESERVED bin", async () => {
    await setBinStatus("B03", "RESERVED");
    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bin_unavailable");
  });

  it("rejects an unknown bin code", async () => {
    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "Z99" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bin_not_found");
  });

  it("reports no_available_bin when the warehouse is full", async () => {
    for (const code of ["A01", "A02", "A03", "B01", "B02", "B03"]) {
      await setBinStatus(code, "OCCUPIED");
    }
    const result = await executePutaway({ scanResult: scanOf() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_available_bin");
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });
});

/* --------------------------------------------------------- gantry gating */

describe("gantry failures", () => {
  it("reports gantry_busy and leaves no reservation behind", async () => {
    // A slow home() keeps the machine occupied across the putaway attempt.
    process.env.GANTRY_SIM_HOME_DELAY_MS = "300";
    resetGantryController();
    const homing = getGantryController().home();

    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gantry_busy");
    expect(await binStatus("B03")).toBe("AVAILABLE");
    expect(await prisma.inventory.count()).toBe(0);

    await homing;
  });

  it("marks the movement FAILED and frees the bin when pickup fails", async () => {
    simulator().failNextOperation("pickup_failed");

    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("gantry_failed");
    expect(result.error).toBe("pickup_failed");
    expect(result.movementId).toBeDefined();
    expect(result.gantryOperationId).toBeDefined();

    expect(await prisma.inventory.count()).toBe(0);
    expect(await binStatus("B03")).toBe("AVAILABLE");

    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId! } });
    expect(movement.status).toBe("FAILED");
    expect(movement.scanId).toBe("scan_1788574200123_a1b2c3"); // history preserved
    expect(movement.idempotencyKey).toBeNull(); // retry is allowed
    expect(movement.gantryOperationId).toBe(result.gantryOperationId);

    const operations = await getGantryController().getRecentOperations();
    expect(operations[0].status).toBe("FAILED");
  });

  it("handles a movement timeout the same way", async () => {
    simulator().failNextOperation("movement_timeout");

    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("movement_timeout");
    expect(await prisma.inventory.count()).toBe(0);
    expect(await binStatus("B03")).toBe("AVAILABLE");
  });

  it("allows the same scan to be retried after a failure", async () => {
    simulator().failNextOperation("drop_failed");
    const first = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });
    expect(first.ok).toBe(false);

    const second = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });
    expect(second.ok).toBe(true);
    expect(await prisma.inventory.count()).toBe(1);
    // Two movements: the failed attempt is kept as operational history.
    expect(await prisma.movement.count()).toBe(2);
  });
});

/* ------------------------------------------------------------ idempotency */

describe("idempotency", () => {
  it("does not put the same scan away twice", async () => {
    const scan = scanOf();

    const first = await executePutaway({ scanResult: scan, destinationBinCode: "B03" });
    const second = await executePutaway({ scanResult: scan, destinationBinCode: "B02" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.duplicate).toBe(true);
    expect(second.inventoryQuantityAdded).toBe(0);
    expect(second.movementId).toBe(first.movementId);
    expect(second.gantryOperationId).toBe(first.gantryOperationId);
    // The second call must not honour its different destination.
    expect(second.destinationBinCode).toBe("B03");

    const inventory = await prisma.inventory.findMany();
    expect(inventory).toHaveLength(1);
    expect(inventory[0].quantity).toBe(1);
    expect(await prisma.movement.count()).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
    expect(await binStatus("B02")).toBe("AVAILABLE");
  });

  it("runs the gantry only once for concurrent duplicates of one scan", async () => {
    const scan = scanOf();
    const results = await Promise.all([
      executePutaway({ scanResult: scan, destinationBinCode: "B03" }),
      executePutaway({ scanResult: scan, destinationBinCode: "B03" }),
    ]);

    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect(await prisma.inventory.count()).toBe(1);
    expect((await prisma.inventory.findMany())[0].quantity).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ concurrency */

describe("concurrent putaway into one bin", () => {
  it("lets exactly one reserve the bin", async () => {
    // Two DIFFERENT scans of the same part racing for one bin. Adding a second
    // near-identical catalog part here would make both scans AMBIGUOUS and
    // test the matcher instead of the reservation.
    const [a, b] = await Promise.all([
      executePutaway({ scanResult: scanOf({ scanId: "scan_1788574200001_aaa" }), destinationBinCode: "B03" }),
      executePutaway({ scanResult: scanOf({ scanId: "scan_1788574200002_bbb" }), destinationBinCode: "B03" }),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    const failed = [a, b].filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const reason = (failed[0] as { reason: string }).reason;
    expect(["bin_reservation_conflict", "bin_unavailable", "gantry_busy"]).toContain(reason);

    // One bin, one SKU, one unit — never double occupancy.
    const inventory = await prisma.inventory.findMany({ include: { bin: true } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].bin.code).toBe("B03");
    expect(inventory[0].quantity).toBe(1);
    expect(await binStatus("B03")).toBe("OCCUPIED");
  });
});

/* ------------------------------------------- commit failure after success */

describe("database commit failure after the gantry succeeded", () => {
  it("does not re-run the gantry and preserves ids for reconciliation", async () => {
    // A real commit failure, not a mock: capacity 0 makes the inventory write
    // inside the commit transaction throw after the part has physically moved.
    await prisma.bin.update({ where: { code: "B03" }, data: { capacity: 0 } });

    const result = await executePutaway({ scanResult: scanOf(), destinationBinCode: "B03" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("putaway_commit_failed");
    expect(result.movementId).toBeDefined();
    expect(result.gantryOperationId).toBeDefined();

    // The gantry ran exactly once and reported success.
    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("COMPLETED");

    // Inventory was NOT written, and the movement is not falsely COMPLETED.
    expect(await prisma.inventory.count()).toBe(0);
    const movement = await prisma.movement.findUniqueOrThrow({ where: { id: result.movementId! } });
    expect(movement.status).toBe("RUNNING");
    expect(movement.completedAt).toBeNull();
  });
});
