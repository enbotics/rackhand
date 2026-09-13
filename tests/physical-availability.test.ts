import { describe, expect, it } from "vitest";
import { physicalAvailability } from "@/lib/engineering-plan/physical-availability";

const count = (binCode = "B5-01", observedQuantity: number | null = 10, usable = true) => ({
  sku: "SENSOR", binCode, recordedQuantity: 12, observedQuantity, usable, inventoryUpdated: false,
  scale: { status: "UNAVAILABLE" as const, totalWeightGrams: null, estimatedQuantity: null },
});
const location = (binCode = "B5-01", quantity = 12, trusted = false) => ({ binCode, quantity, trusted, binStatus: "OCCUPIED" });

describe("plan physical availability", () => {
  it("replaces recorded 12 with physically found 10 without requiring an inventory write", () => {
    const available = physicalAvailability("SENSOR", [location()], [count()]);
    expect(available).toBe(10);
    expect(11 - available!).toBe(1);
  });
  it("does not double-count a reconciled bin", () => {
    expect(physicalAvailability("SENSOR", [location("B5-01", 10, true)], [count()])).toBe(10);
  });
  it("combines checks across bins and recent accepted stock", () => {
    expect(physicalAvailability("SENSOR", [location(), location("B5-02", 3, true)], [count()])).toBe(13);
  });
  it("keeps unsafe and uncountable evidence unresolved instead of treating it as empty", () => {
    expect(physicalAvailability("SENSOR", [location()], [count("B5-01", 10, false)])).toBeNull();
    expect(physicalAvailability("SENSOR", [location()], [count("B5-01", null, false)])).toBeNull();
    expect(physicalAvailability("SENSOR", [location(), location("B5-02")], [count()])).toBeNull();
  });
  it("preserves a verified zero even after inventory is removed", () => {
    expect(physicalAvailability("SENSOR", [], [count("B5-01", 0)])).toBe(0);
  });
});
