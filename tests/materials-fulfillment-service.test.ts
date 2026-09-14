import { beforeEach, describe, expect, it, vi } from "vitest";

const inventoryBySku = new Map<
  string,
  Array<{ binCode: string; binStatus: "OCCUPIED" | "CHECKED_OUT"; quantity: number }>
>();
const untrustedBins = new Set<string>();

vi.mock("@/lib/warehouse/inventory-service", () => ({
  getInventoryForPart: vi.fn(async (sku: string) => {
    const locations = inventoryBySku.get(sku);
    if (!locations) throw new Error("part not found");
    return {
      part: { id: `part-${sku}`, sku, canonicalName: sku },
      totalQuantity: locations
        .filter((location) => location.binStatus === "OCCUPIED")
        .reduce((sum, location) => sum + location.quantity, 0),
      checkedOutQuantity: locations
        .filter((location) => location.binStatus === "CHECKED_OUT")
        .reduce((sum, location) => sum + location.quantity, 0),
      recordedQuantity: locations.reduce(
        (sum, location) => sum + location.quantity,
        0,
      ),
      locations,
    };
  }),
}));

vi.mock("@/lib/warehouse/bin-verification-evidence", () => ({
  getBinVerificationEvidence: vi.fn(async (binCodes: string[]) =>
    new Map(
      binCodes.map((binCode) => [
        binCode,
        {
          binCode,
          state: untrustedBins.has(binCode) ? "CHANGED_AFTER_VERIFICATION" : "TRUSTED",
          trusted: !untrustedBins.has(binCode),
          lastVerifiedAt: "2026-09-12T00:00:00.000Z",
          lastInventoryChangeAt: untrustedBins.has(binCode)
            ? "2026-09-12T01:00:00.000Z"
            : "2026-09-12T00:00:00.000Z",
          latestAuditStatus: "VERIFIED",
          reason: untrustedBins.has(binCode)
            ? "inventory-changing activity occurred after the latest trusted verification"
            : "latest trusted verification is current",
        },
      ]),
    ),
  ),
}));

import { prepareMaterialsFulfillment } from "@/lib/warehouse/materials-fulfillment-service";

const requirement = (sku: string, quantity: number) => ({
  sku,
  purpose: "test build",
  category: "test material",
  quantity,
});

beforeEach(() => {
  inventoryBySku.clear();
  untrustedBins.clear();
});

describe("materials fulfillment preparation", () => {
  it("uses the screws already at checkout for an explicitly opted-in prep", async () => {
    inventoryBySku.set("SCREW-M4-30", [
      { binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 },
    ]);
    const plan = await prepareMaterialsFulfillment([requirement("SCREW-M4-30", 10)], {
      requireTrustedEvidence: false, includeCheckedOutBins: true,
    });
    expect(plan).toMatchObject({ ok: true, selectedBins: [
      { sku: "SCREW-M4-30", binCode: "B1-01", recordedQuantity: 18, alreadyCheckedOut: true },
    ] });
  });

  it("still excludes checkout stock from shelf analysis and prep without opt-in", async () => {
    inventoryBySku.set("SCREW-M4-30", [
      { binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 },
    ]);
    for (const options of [{}, { requireTrustedEvidence: false }, { includeCheckedOutBins: true }]) {
      expect(await prepareMaterialsFulfillment([requirement("SCREW-M4-30", 10)], options))
        .toMatchObject({ ok: false, reason: "materials_shortage", shortages: [{ available: 0 }] });
    }
  });

  it("uses checkout first even if that material is later in the requirements", async () => {
    inventoryBySku.set("BRACKET", [{ binCode: "B1-02", binStatus: "OCCUPIED", quantity: 6 }]);
    inventoryBySku.set("SCREW-M4-30", [
      { binCode: "B1-03", binStatus: "OCCUPIED", quantity: 20 },
      { binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 },
    ]);
    const plan = await prepareMaterialsFulfillment([requirement("BRACKET", 2), requirement("SCREW-M4-30", 10)], {
      requireTrustedEvidence: false, includeCheckedOutBins: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.selectedBins.map((bin) => bin.binCode)).toEqual(["B1-01", "B1-02"]);
  });

  it("reports a real shortage using the actual checkout quantity", async () => {
    inventoryBySku.set("SCREW-M4-30", [{ binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 8 }]);
    expect(await prepareMaterialsFulfillment([requirement("SCREW-M4-30", 10)], {
      requireTrustedEvidence: false, includeCheckedOutBins: true,
    })).toMatchObject({ ok: false, reason: "materials_shortage",
      shortages: [{ sku: "SCREW-M4-30", required: 10, available: 8 }],
      message: expect.stringContaining("8 are available on the shelf or at checkout"),
    });
  });

  it("requires extra checked-out bins to return before starting a queue", async () => {
    inventoryBySku.set("BRACKET", [{ binCode: "B1-02", binStatus: "CHECKED_OUT", quantity: 6 }]);
    inventoryBySku.set("SCREW-M4-30", [{ binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 }]);
    expect(await prepareMaterialsFulfillment([requirement("BRACKET", 2), requirement("SCREW-M4-30", 10)], {
      requireTrustedEvidence: false, includeCheckedOutBins: true,
    })).toMatchObject({ ok: false, reason: "materials_plan_invalid",
      message: expect.stringContaining("More than one selected bin is checked out"),
    });
  });

  it("selects only enough occupied bins and uses physical shelf order", async () => {
    inventoryBySku.set("SKU-1", [
      { binCode: "B1-01", binStatus: "OCCUPIED", quantity: 4 },
      { binCode: "B4-02", binStatus: "OCCUPIED", quantity: 3 },
      { binCode: "B3-01", binStatus: "CHECKED_OUT", quantity: 50 },
    ]);

    const plan = await prepareMaterialsFulfillment([requirement("sku-1", 5)]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.selectedBins.map((bin) => bin.binCode)).toEqual([
      "B4-02",
      "B1-01",
    ]);
    expect(plan.selectedBins.every((bin) => bin.verification?.trusted)).toBe(true);
  });

  it("reports a shortage without discarding bins ready for other materials", async () => {
    inventoryBySku.set("SKU-1", [
      { binCode: "B2-01", binStatus: "OCCUPIED", quantity: 3 },
    ]);
    inventoryBySku.set("SKU-2", [
      { binCode: "B3-01", binStatus: "OCCUPIED", quantity: 1 },
    ]);

    const plan = await prepareMaterialsFulfillment([
      requirement("SKU-1", 2),
      requirement("SKU-2", 4),
    ]);

    expect(plan).toMatchObject({
      ok: false,
      reason: "materials_shortage",
      selectedBins: [
        {
          sku: "SKU-1",
          binCode: "B2-01",
          recordedQuantity: 3,
          requiredQuantity: 2,
        },
      ],
      shortages: [{ sku: "SKU-2", required: 4, available: 1 }],
    });
  });

  it("continues requesting relevant verification even when another SKU is already short", async () => {
    inventoryBySku.set("SKU-SHORT", [
      { binCode: "B2-01", binStatus: "OCCUPIED", quantity: 1 },
    ]);
    inventoryBySku.set("SKU-CHECK", [
      { binCode: "B3-01", binStatus: "OCCUPIED", quantity: 4 },
    ]);
    untrustedBins.add("B3-01");

    const plan = await prepareMaterialsFulfillment(
      [requirement("SKU-SHORT", 4), requirement("SKU-CHECK", 4)],
      { continueAfterKnownShortage: true },
    );

    expect(plan).toMatchObject({
      ok: false,
      reason: "materials_verification_required",
      shortages: [{ sku: "SKU-SHORT", required: 4, available: 1 }],
      verificationTargets: [{ sku: "SKU-CHECK", binCode: "B3-01" }],
    });
  });

  it("aggregates duplicate SKU quantities before selecting bins", async () => {
    inventoryBySku.set("SKU-1", [
      { binCode: "B4-01", binStatus: "OCCUPIED", quantity: 2 },
      { binCode: "B3-01", binStatus: "OCCUPIED", quantity: 3 },
    ]);

    const plan = await prepareMaterialsFulfillment([
      requirement("SKU-1", 2),
      requirement("sku-1", 2),
    ]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0].quantity).toBe(4);
    expect(plan.selectedBins).toHaveLength(2);
  });

  it("selects only the minimum uncertain stock needed for physical verification", async () => {
    inventoryBySku.set("SKU-1", [
      { binCode: "B1-01", binStatus: "OCCUPIED", quantity: 2 },
      { binCode: "B2-01", binStatus: "OCCUPIED", quantity: 3 },
      { binCode: "B3-01", binStatus: "OCCUPIED", quantity: 6 },
    ]);
    untrustedBins.add("B2-01");
    untrustedBins.add("B3-01");

    const plan = await prepareMaterialsFulfillment([requirement("SKU-1", 8)]);

    expect(plan).toMatchObject({
      ok: false,
      reason: "materials_verification_required",
      verificationTargets: [{ sku: "SKU-1", binCode: "B3-01", recordedQuantity: 6 }],
    });
  });

  it("does not reselect an uncertain bin that was already attempted", async () => {
    inventoryBySku.set("SKU-1", [
      { binCode: "B1-01", binStatus: "OCCUPIED", quantity: 2 },
      { binCode: "B2-01", binStatus: "OCCUPIED", quantity: 6 },
    ]);
    untrustedBins.add("B2-01");

    const plan = await prepareMaterialsFulfillment([requirement("SKU-1", 8)], {
      excludeVerificationBinCodes: ["B2-01"],
    });

    expect(plan).toMatchObject({
      ok: false,
      reason: "materials_verification_incomplete",
      shortages: [{ sku: "SKU-1", required: 8, available: 2 }],
    });
  });

  it("includes trusted and untrusted stocked bins in an approved preparation job", async () => {
    inventoryBySku.set("MOUNTING-KIT", [
      { binCode: "B4-01", binStatus: "OCCUPIED", quantity: 10 },
    ]);
    inventoryBySku.set("MOTOR-DRIVER", [
      { binCode: "B3-03", binStatus: "OCCUPIED", quantity: 4 },
    ]);
    inventoryBySku.set("SPACER", [
      { binCode: "B6-03", binStatus: "OCCUPIED", quantity: 38 },
    ]);
    untrustedBins.add("B4-01");
    untrustedBins.add("B6-03");

    const plan = await prepareMaterialsFulfillment(
      [
        requirement("MOUNTING-KIT", 1),
        requirement("MOTOR-DRIVER", 1),
        requirement("SPACER", 4),
      ],
      { requireTrustedEvidence: false },
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.selectedBins.map((bin) => bin.binCode)).toEqual([
      "B4-01",
      "B3-03",
      "B6-03",
    ]);
  });
});
