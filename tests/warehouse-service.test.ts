import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { WarehouseError } from "@/lib/warehouse/errors";
import {
  createMovement,
  createPart,
  findAvailableBin,
  getMovement,
  getPartById,
  getPartBySku,
  listBins,
  listParts,
  setBinStatus,
  updateMovementStatus,
} from "@/lib/warehouse/repository";
import {
  addInventory,
  getInventoryByBin,
  getInventoryForPart,
  listInventory,
  removeInventory,
} from "@/lib/warehouse/inventory-service";
import { assertTestDatabase, resetWarehouse, SAMPLE_PART } from "./helpers";
import { SEED_BIN_CODES } from "@/lib/warehouse/types";

/** Asserts a promise rejects with a WarehouseError carrying `code`. */
async function expectWarehouseError(promise: Promise<unknown>, code: string): Promise<WarehouseError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WarehouseError);
    const error = err as WarehouseError;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected a WarehouseError with code "${code}", but the call succeeded.`);
}

beforeEach(async () => {
  await resetWarehouse();
});

describe("catalog", () => {
  it("creates a valid part", async () => {
    const part = await createPart(SAMPLE_PART);
    expect(part.sku).toBe("BRG-6204");
    expect(part.canonicalName).toBe("6204 Deep Groove Ball Bearing");
    expect(part.lengthMM).toBe(47);
    expect(part.id).toBeTruthy();
    expect(await getPartById(part.id)).not.toBeNull();
    expect(await getPartBySku("brg-6204")).not.toBeNull();
  });

  it("rejects a duplicate SKU", async () => {
    await createPart(SAMPLE_PART);
    const error = await expectWarehouseError(
      createPart({ ...SAMPLE_PART, canonicalName: "A different name" }),
      "duplicate_sku",
    );
    expect(error.status).toBe(409);
    expect(await listParts()).toHaveLength(1);
  });

  it("rejects invalid part input with field-level issues", async () => {
    const error = await expectWarehouseError(
      createPart({ ...SAMPLE_PART, sku: "  ", canonicalName: "", lengthMM: -5 }),
      "validation_failed",
    );
    expect(error.status).toBe(422);
    expect(error.issues).toHaveLength(3);
    expect(await listParts()).toHaveLength(0);
  });

  it("rejects a non-finite dimension", async () => {
    await expectWarehouseError(
      createPart({ ...SAMPLE_PART, widthMM: Number.NaN }),
      "validation_failed",
    );
  });

  it("allows a part with no known dimensions", async () => {
    const part = await createPart({ sku: "UNK-1", canonicalName: "Unmeasured part" });
    expect(part.lengthMM).toBeNull();
    expect(part.heightMM).toBeNull();
  });

  it("keeps Part free of any scan identity", async () => {
    const part = await createPart(SAMPLE_PART);
    for (const forbidden of ["scanId", "scanResult", "detectedName", "capturedAt"]) {
      expect(Object.keys(part)).not.toContain(forbidden);
    }
  });
});

describe("bins", () => {
  it("has every seeded storage bin", async () => {
    const bins = await listBins();
    expect(bins.map((b) => b.code)).toEqual([...SEED_BIN_CODES]);
    expect(bins.every((b) => b.status === "AVAILABLE")).toBe(true);
  });

  it("finds the first AVAILABLE bin by code", async () => {
    const bin = await findAvailableBin();
    expect(bin?.code).toBe("B1-01");
  });

  it("ignores OCCUPIED, DISABLED and RESERVED bins", async () => {
    await setBinStatus("B1-01", "OCCUPIED");
    await setBinStatus("B1-02", "DISABLED");
    await setBinStatus("B1-03", "RESERVED");
    const bin = await findAvailableBin();
    expect(bin?.code).toBe("B1-04");
  });

  it("returns null when no bin is available", async () => {
    for (const code of SEED_BIN_CODES) {
      await setBinStatus(code, "DISABLED");
    }
    expect(await findAvailableBin()).toBeNull();
  });

  it("rejects an unknown bin code", async () => {
    await expectWarehouseError(setBinStatus("Z99", "DISABLED"), "bin_not_found");
  });
});

describe("inventory", () => {
  beforeEach(async () => {
    await createPart(SAMPLE_PART);
  });

  it("adds inventory and marks the bin OCCUPIED", async () => {
    const record = await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    expect(record).toMatchObject({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });

    const summary = await getInventoryForPart("BRG-6204");
    expect(summary.totalQuantity).toBe(2);
    expect(summary.locations).toEqual([{ binCode: "B2-01", binStatus: "OCCUPIED", quantity: 2 }]);
  });

  it("accumulates repeated adds into one row", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 3 });
    expect((await getInventoryForPart("BRG-6204")).totalQuantity).toBe(5);
    expect(await listInventory()).toHaveLength(1);
  });

  it("removes inventory", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 5 });
    const record = await removeInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    expect(record.quantity).toBe(3);
    expect((await getInventoryForPart("BRG-6204")).totalQuantity).toBe(3);
  });

  it("frees the bin when the last unit is removed", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    await removeInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });

    const bin = await prisma.bin.findUniqueOrThrow({ where: { code: "B2-01" } });
    expect(bin.status).toBe("AVAILABLE");
    expect(await getInventoryByBin("B2-01")).toHaveLength(0);
  });

  it("refuses to remove more than is available and leaves the quantity untouched", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const error = await expectWarehouseError(
      removeInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 3 }),
      "insufficient_inventory",
    );
    expect(error.status).toBe(409);
    expect((await getInventoryForPart("BRG-6204")).totalQuantity).toBe(2);
  });

  it("never lets a quantity go negative", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 });
    await expectWarehouseError(
      removeInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 99 }),
      "insufficient_inventory",
    );
    const rows = await prisma.inventory.findMany();
    expect(rows.every((row) => row.quantity >= 0)).toBe(true);
  });

  it("rejects a zero or fractional quantity", async () => {
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 0 }),
      "validation_failed",
    );
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1.5 }),
      "validation_failed",
    );
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: -3 }),
      "validation_failed",
    );
  });

  it("rejects an unknown part or bin", async () => {
    await expectWarehouseError(
      addInventory({ sku: "NOPE-1", binCode: "B2-01", quantity: 1 }),
      "part_not_found",
    );
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "Z99", quantity: 1 }),
      "bin_not_found",
    );
  });

  it("refuses to remove stock that was never there", async () => {
    await expectWarehouseError(
      removeInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 }),
      "inventory_not_found",
    );
  });

  it("keeps one SKU per bin", async () => {
    await createPart({ sku: "BLT-M6", canonicalName: "M6 hex bolt" });
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 });
    await expectWarehouseError(
      addInventory({ sku: "BLT-M6", binCode: "B2-01", quantity: 1 }),
      "inventory_conflict",
    );
  });

  it("prevents duplicate rows for the same part and bin", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 });
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 });
    const rows = await prisma.inventory.findMany({ where: { bin: { code: "B2-01" } } });
    expect(rows).toHaveLength(1);
  });

  it("refuses to store stock in a DISABLED bin", async () => {
    await setBinStatus("B2-01", "DISABLED");
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 }),
      "bin_unavailable",
    );
  });

  it("refuses to exceed a bin's capacity", async () => {
    await prisma.bin.update({ where: { code: "B2-01" }, data: { capacity: 4 } });
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 3 });
    await expectWarehouseError(
      addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 }),
      "bin_capacity_exceeded",
    );
    expect((await getInventoryForPart("BRG-6204")).totalQuantity).toBe(3);
  });
});

describe("movements", () => {
  beforeEach(async () => {
    await createPart(SAMPLE_PART);
  });

  it("creates a PENDING movement without touching inventory", async () => {
    const movement = await createMovement({
      type: "PUTAWAY",
      sku: "BRG-6204",
      quantity: 2,
      sourceLocation: "INTAKE",
      destinationBinCode: "B2-01",
    });

    expect(movement.status).toBe("PENDING");
    expect(movement.completedAt).toBeNull();
    expect(movement.sourceBinId).toBeNull();
    expect(movement.destinationBinId).not.toBeNull();
    expect(await listInventory()).toHaveLength(0);
  });

  it("transitions to another valid status", async () => {
    const movement = await createMovement({
      type: "RETRIEVAL",
      sku: "BRG-6204",
      quantity: 1,
      sourceBinCode: "B1-01",
      destinationLocation: "OUTPUT",
    });

    const validated = await updateMovementStatus(movement.id, "VALIDATED");
    expect(validated.status).toBe("VALIDATED");
    expect(validated.completedAt).toBeNull();

    const running = await updateMovementStatus(movement.id, "RUNNING");
    expect(running.status).toBe("RUNNING");
  });

  it("stamps completedAt only on an explicit terminal transition", async () => {
    const movement = await createMovement({
      type: "TRANSFER",
      sku: "BRG-6204",
      quantity: 1,
      sourceBinCode: "B1-01",
      destinationBinCode: "B1-02",
    });
    expect(movement.completedAt).toBeNull();

    const completed = await updateMovementStatus(movement.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("refuses to create a movement that claims to be already done", async () => {
    await expectWarehouseError(
      createMovement({
        type: "PUTAWAY",
        sku: "BRG-6204",
        quantity: 1,
        destinationBinCode: "B2-01",
        status: "COMPLETED",
      }),
      "invalid_status_transition",
    );
  });

  it("freezes a terminal movement", async () => {
    const movement = await createMovement({
      type: "PUTAWAY",
      sku: "BRG-6204",
      quantity: 1,
      destinationBinCode: "B2-01",
    });
    await updateMovementStatus(movement.id, "CANCELLED");
    await expectWarehouseError(
      updateMovementStatus(movement.id, "RUNNING"),
      "invalid_status_transition",
    );
  });

  it("rejects invalid movement input", async () => {
    await expectWarehouseError(
      createMovement({ type: "TELEPORT" as never, sku: "BRG-6204", quantity: 1, destinationBinCode: "B2-01" }),
      "validation_failed",
    );
    await expectWarehouseError(
      createMovement({ type: "PUTAWAY", sku: "BRG-6204", quantity: 0, destinationBinCode: "B2-01" }),
      "validation_failed",
    );
    await expectWarehouseError(
      createMovement({ type: "PUTAWAY", sku: "BRG-6204", quantity: 1 }),
      "validation_failed",
    );
    await expectWarehouseError(
      createMovement({ type: "PUTAWAY", sku: "NOPE-1", quantity: 1, destinationBinCode: "B2-01" }),
      "part_not_found",
    );
    await expectWarehouseError(
      createMovement({ type: "PUTAWAY", sku: "BRG-6204", quantity: 1, destinationBinCode: "Z99" }),
      "bin_not_found",
    );
  });

  it("rejects an unknown movement id and an invalid status", async () => {
    await expectWarehouseError(updateMovementStatus("nope", "RUNNING"), "movement_not_found");
    const movement = await createMovement({
      type: "PUTAWAY",
      sku: "BRG-6204",
      quantity: 1,
      destinationBinCode: "B2-01",
    });
    await expectWarehouseError(
      updateMovementStatus(movement.id, "TELEPORTED" as never),
      "validation_failed",
    );
    expect((await getMovement(movement.id))?.status).toBe("PENDING");
  });
});

describe("test database guard", () => {
  it("accepts the configured test database", () => {
    expect(process.env.DATABASE_URL).toContain("test-warehouse");
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it("refuses anything that is not a test database", () => {
    const original = process.env.DATABASE_URL;
    try {
      for (const url of ["file:./prisma/dev.db", "", undefined]) {
        if (url === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = url;
        expect(() => assertTestDatabase()).toThrow(/Refusing to run destructive test setup/);
      }
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});
