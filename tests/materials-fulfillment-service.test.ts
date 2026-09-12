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
      checkedOutQuantity: 0,
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
  });

  it("rejects the whole plan when any required SKU is short", async () => {
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
      shortages: [{ sku: "SKU-2", required: 4, available: 1 }],
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
});
