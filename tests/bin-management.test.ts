import { beforeEach, describe, expect, it } from "vitest";
import { WarehouseError } from "@/lib/warehouse/errors";
import {
  addBinsToBed,
  createBed,
  createPart,
  deleteBed,
  deleteBin,
  listBinsInBed,
  updateBin,
} from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { resetWarehouse, SAMPLE_PART } from "./helpers";

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

describe("updateBin", () => {
  it("updates status and capacity", async () => {
    const bin = await updateBin("B1-01", { status: "DISABLED", capacity: 50 });
    expect(bin.status).toBe("DISABLED");
    expect(bin.capacity).toBe(50);
  });

  it("rejects an unknown bin code", async () => {
    await expectWarehouseError(updateBin("Z99-01", { capacity: 10 }), "bin_not_found");
  });

  it("rejects an empty patch", async () => {
    await expectWarehouseError(updateBin("B1-01", {}), "validation_failed");
  });
});

describe("deleteBin", () => {
  it("deletes an empty bin", async () => {
    await deleteBin("B1-01");
    const remaining = await listBinsInBed(1);
    expect(remaining.map((b) => b.code)).not.toContain("B1-01");
  });

  it("rejects an unknown bin code", async () => {
    await expectWarehouseError(deleteBin("Z99-01"), "bin_not_found");
  });

  it("blocks deleting a bin that still holds inventory, naming it in issues", async () => {
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B1-01", quantity: 1 });

    const error = await expectWarehouseError(deleteBin("B1-01"), "bin_has_inventory");
    expect(error.issues).toEqual(["B1-01"]);

    const remaining = await listBinsInBed(1);
    expect(remaining.map((b) => b.code)).toContain("B1-01");
  });
});

describe("createBed", () => {
  it("creates sequential AVAILABLE bins for a fresh bed", async () => {
    const bins = await createBed({ bed: 7, slotCount: 3 });
    expect(bins.map((b) => b.code)).toEqual(["B7-01", "B7-02", "B7-03"]);
    expect(bins.every((b) => b.status === "AVAILABLE" && b.capacity === 100)).toBe(true);
  });

  it("rejects a bed that already has bins", async () => {
    await expectWarehouseError(createBed({ bed: 1, slotCount: 1 }), "duplicate_bin_code");
  });
});

describe("addBinsToBed", () => {
  it("appends slots after the current highest one", async () => {
    const bins = await addBinsToBed({ bed: 1, slotCount: 2 });
    expect(bins.map((b) => b.code)).toEqual([
      "B1-01",
      "B1-02",
      "B1-03",
      "B1-04",
      "B1-05",
      "B1-06",
      "B1-07",
    ]);
  });

  it("rejects a bed with no existing bins", async () => {
    await expectWarehouseError(addBinsToBed({ bed: 9, slotCount: 1 }), "bin_not_found");
  });
});

describe("deleteBed", () => {
  it("deletes every bin in an empty bed", async () => {
    const result = await deleteBed(6);
    expect(result.deleted).toBe(5);
    expect(await listBinsInBed(6)).toHaveLength(0);
  });

  it("rejects a bed with no bins", async () => {
    await expectWarehouseError(deleteBed(9), "bin_not_found");
  });

  it("blocks deleting a bed when any bin holds inventory, listing every blocking code", async () => {
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B6-01", quantity: 1 });
    await createPart({ ...SAMPLE_PART, sku: "BOLT-M8-50" });
    await addInventory({ sku: "BOLT-M8-50", binCode: "B6-03", quantity: 1 });

    const error = await expectWarehouseError(deleteBed(6), "bin_has_inventory");
    expect(error.issues).toEqual(["B6-01", "B6-03"]);
    expect(await listBinsInBed(6)).toHaveLength(5);
  });
});
