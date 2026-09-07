import { beforeEach, describe, expect, it } from "vitest";
import {
  createMovement,
  createPart,
  setBinStatus,
  updateMovementStatus,
} from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { getWarehouseOverview } from "@/lib/warehouse/dashboard-service";
import {
  BIN_STATUS_PRESENTATION,
  MOVEMENT_STATUS_PRESENTATION,
  SCAN_IDENTITY_PRESENTATION,
  deriveScanIdentity,
  describeMeasureFailure,
  filterInventory,
  formatLocations,
} from "@/lib/warehouse/dashboard-presentation";
import { SEED_BIN_CODES } from "@/lib/warehouse/types";
import { resetWarehouse, SAMPLE_PART } from "./helpers";

/**
 * Milestone 10's read model and its labelling.
 *
 * The point of these tests is that the DASHBOARD cannot invent warehouse
 * state. Everything it draws is asserted here against the database rows it
 * came from — bin status, quantities, locations and movement history — so a
 * screen that disagrees with the warehouse fails the suite rather than the
 * demo.
 */
describe("warehouse overview (dashboard read model)", () => {
  beforeEach(async () => {
    await resetWarehouse();
  });

  it("reports an empty warehouse honestly rather than as missing data", async () => {
    const overview = await getWarehouseOverview();

    expect(overview.bins).toHaveLength(SEED_BIN_CODES.length);
    expect(overview.bins.map((bin) => bin.code)).toEqual([...SEED_BIN_CODES]);
    expect(overview.bins.every((bin) => bin.status === "AVAILABLE")).toBe(true);
    expect(overview.bins.every((bin) => bin.contents.length === 0)).toBe(true);
    expect(overview.inventory).toEqual([]);
    expect(overview.movements).toEqual([]);
    expect(overview.totals).toEqual({
      units: 0,
      distinctParts: 0,
      binsAvailable: SEED_BIN_CODES.length,
      binsOccupied: 0,
    });
  });

  it("shows stored stock in the bin that holds it", async () => {
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B2-01", quantity: 2 });
    await setBinStatus("B2-01", "OCCUPIED");

    const overview = await getWarehouseOverview();
    const b03 = overview.bins.find((bin) => bin.code === "B2-01");

    expect(b03?.status).toBe("OCCUPIED");
    expect(b03?.totalQuantity).toBe(2);
    expect(b03?.contents).toEqual([
      {
        partId: expect.any(String),
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        quantity: 2,
      },
    ]);
    // Every other bin is still empty — stock never appears where it is not.
    expect(overview.bins.filter((bin) => bin.contents.length > 0)).toHaveLength(1);
  });

  it("reflects every bin status from the database, not from occupancy", async () => {
    await setBinStatus("B1-01", "AVAILABLE");
    await setBinStatus("B1-02", "RESERVED");
    await setBinStatus("B1-03", "DISABLED");
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B1-04", quantity: 1 });
    await setBinStatus("B1-04", "OCCUPIED");

    const overview = await getWarehouseOverview();
    const statuses = Object.fromEntries(overview.bins.map((bin) => [bin.code, bin.status]));

    expect(statuses).toMatchObject({
      "B1-01": "AVAILABLE",
      "B1-02": "RESERVED",
      "B1-03": "DISABLED",
      "B1-04": "OCCUPIED",
    });
    // A RESERVED bin is empty and still not available. The two facts are
    // separate, and the view must not collapse them.
    expect(overview.bins.find((bin) => bin.code === "B1-02")?.contents).toEqual([]);
    // Everything except the RESERVED, DISABLED and OCCUPIED ones above.
    expect(overview.totals.binsAvailable).toBe(SEED_BIN_CODES.length - 3);
    expect(overview.totals.binsOccupied).toBe(1);
  });

  it("aggregates one part held in several bins into a single inventory row", async () => {
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B1-02", quantity: 1 });
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B2-01", quantity: 2 });

    const overview = await getWarehouseOverview();

    expect(overview.inventory).toHaveLength(1);
    expect(overview.inventory[0]).toMatchObject({
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      category: "bearing",
      totalQuantity: 3,
      locations: [
        { binCode: "B1-02", quantity: 1 },
        { binCode: "B2-01", quantity: 2 },
      ],
    });
    expect(overview.totals).toMatchObject({ units: 3, distinctParts: 1 });
  });

  it("does not draw a part into a bin whose stock has gone to zero", async () => {
    await createPart(SAMPLE_PART);
    await addInventory({ sku: SAMPLE_PART.sku, binCode: "B1-05", quantity: 1 });
    const { removeInventory } = await import("@/lib/warehouse/inventory-service");
    await removeInventory({ sku: SAMPLE_PART.sku, binCode: "B1-05", quantity: 1 });

    const overview = await getWarehouseOverview();

    expect(overview.bins.find((bin) => bin.code === "B1-05")?.contents).toEqual([]);
    expect(overview.inventory).toEqual([]);
    expect(overview.totals.units).toBe(0);
  });

  it("resolves movement rows to SKUs, bin codes and stations", async () => {
    await createPart(SAMPLE_PART);
    const putaway = await createMovement({
      type: "PUTAWAY",
      sku: SAMPLE_PART.sku,
      quantity: 1,
      sourceLocation: "INTAKE",
      destinationBinCode: "B2-01",
    });
    await updateMovementStatus(putaway.id, "COMPLETED");

    const failed = await createMovement({
      type: "RETRIEVAL",
      sku: SAMPLE_PART.sku,
      quantity: 1,
      sourceBinCode: "B2-01",
      destinationLocation: "OUTPUT",
    });
    await updateMovementStatus(failed.id, "FAILED");

    const overview = await getWarehouseOverview();

    expect(overview.movements).toHaveLength(2);
    // Newest first.
    expect(overview.movements[0]).toMatchObject({
      type: "RETRIEVAL",
      status: "FAILED",
      sku: "BRG-6204",
      source: "B2-01",
      destination: "OUTPUT",
    });
    expect(overview.movements[1]).toMatchObject({
      type: "PUTAWAY",
      status: "COMPLETED",
      sku: "BRG-6204",
      source: "INTAKE",
      destination: "B2-01",
    });
    expect(overview.movements[0].completedAt).toBeTypeOf("number");
  });

  it("caps the movement history it returns", async () => {
    await createPart(SAMPLE_PART);
    for (let index = 0; index < 12; index += 1) {
      await createMovement({
        type: "PUTAWAY",
        sku: SAMPLE_PART.sku,
        quantity: 1,
        sourceLocation: "INTAKE",
        destinationBinCode: "B2-01",
      });
    }

    expect((await getWarehouseOverview()).movements).toHaveLength(8);
    expect((await getWarehouseOverview(3)).movements).toHaveLength(3);
    // A hostile limit cannot turn the panel into a full table scan.
    expect((await getWarehouseOverview(9999)).movements.length).toBeLessThanOrEqual(50);
  });
});

describe("dashboard presentation", () => {
  it("gives every status a word and a symbol, never colour alone", () => {
    const all = [
      ...Object.values(BIN_STATUS_PRESENTATION),
      ...Object.values(MOVEMENT_STATUS_PRESENTATION),
      ...Object.values(SCAN_IDENTITY_PRESENTATION),
    ];
    for (const status of all) {
      expect(status.label.trim()).not.toBe("");
      expect(status.symbol.trim()).not.toBe("");
    }
  });

  it("never renders a human decision as a machine match", () => {
    expect(
      deriveScanIdentity({ hasValidScan: true, matchStatus: "AMBIGUOUS", humanConfirmed: true }),
    ).toBe("HUMAN_CONFIRMED");
    expect(SCAN_IDENTITY_PRESENTATION.HUMAN_CONFIRMED.label).not.toBe(
      SCAN_IDENTITY_PRESENTATION.MATCHED.label,
    );
  });

  it("derives the remaining identity states from the matcher alone", () => {
    expect(
      deriveScanIdentity({ hasValidScan: true, matchStatus: "MATCHED", humanConfirmed: false }),
    ).toBe("MATCHED");
    expect(
      deriveScanIdentity({ hasValidScan: true, matchStatus: "AMBIGUOUS", humanConfirmed: false }),
    ).toBe("AMBIGUOUS");
    expect(
      deriveScanIdentity({ hasValidScan: true, matchStatus: "NO_MATCH", humanConfirmed: false }),
    ).toBe("NO_MATCH");
    expect(
      deriveScanIdentity({ hasValidScan: true, matchStatus: null, humanConfirmed: false }),
    ).toBeNull();
  });

  it("marks an unusable scan invalid even if a human tried to confirm it", () => {
    expect(
      deriveScanIdentity({ hasValidScan: false, matchStatus: null, humanConfirmed: true }),
    ).toBe("INVALID_SCAN");
  });

  it("turns a measurement error code into operator guidance, not a stack trace", () => {
    const failure = describeMeasureFailure("mat_not_detected", "Calibration mat not detected.");
    expect(failure.title).toBe("Calibration mat not detected.");
    expect(failure.guidance).toContain("four corner QR codes");

    const unknown = describeMeasureFailure("something_new", undefined);
    expect(unknown.title).toBe("The scan could not be measured.");
    expect(unknown.guidance).toBe("Check the mat and the part, then scan again.");
  });

  it("filters inventory by SKU, name and category without changing the data", () => {
    const rows = [
      {
        partId: "p1",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        category: "bearing",
        totalQuantity: 2,
        locations: [{ binCode: "B2-01", quantity: 2 }],
      },
      {
        partId: "p2",
        sku: "BOLT-M8-50",
        canonicalName: "M8 x 50 Hex Bolt",
        category: "fastener",
        totalQuantity: 5,
        locations: [{ binCode: "B1-01", quantity: 5 }],
      },
    ];

    expect(filterInventory(rows, "brg").map((row) => row.sku)).toEqual(["BRG-6204"]);
    expect(filterInventory(rows, "hex bolt").map((row) => row.sku)).toEqual(["BOLT-M8-50"]);
    expect(filterInventory(rows, "fastener").map((row) => row.sku)).toEqual(["BOLT-M8-50"]);
    expect(filterInventory(rows, "")).toEqual(rows);
    expect(filterInventory(rows, "nothing-here")).toEqual([]);
  });

  it("formats one location plainly and several with their quantities", () => {
    expect(formatLocations([{ binCode: "B2-01", quantity: 2 }])).toBe("B2-01");
    expect(
      formatLocations([
        { binCode: "B1-02", quantity: 1 },
        { binCode: "B2-01", quantity: 2 },
      ]),
    ).toBe("B1-02 (1), B2-01 (2)");
    expect(formatLocations([])).toBe("—");
  });
});
