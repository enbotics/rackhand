import { afterEach, describe, expect, it } from "vitest";
import {
  configuredContainerTareGrams,
  knownPartUnitWeightGrams,
  verifyPhysicalWeight,
} from "@/lib/warehouse/putaway-weight";

const originalTare = process.env.PUTAWAY_CONTAINER_TARE_GRAMS;
afterEach(() => {
  if (originalTare === undefined) delete process.env.PUTAWAY_CONTAINER_TARE_GRAMS;
  else process.env.PUTAWAY_CONTAINER_TARE_GRAMS = originalTare;
});

const reading = {
  totalWeightGrams: 122.6, quantity: 12, weightSource: "SCALE",
  simulated: false, knownUnitWeightGrams: 1.56,
};

describe("scale-based bin counting", () => {
  it.each([
    ["HARDWARE-ROUND-SPACER", "Round unthreaded spacer", 6.2],
    ["BEARING-KIT", "V-groove bearing wheel hardware kit", 19],
    ["DRIVER-MKS-TMC2160-OC-V1", "Motor driver", 47.12],
    ["ELECTRONICS-SENSOR-MODULE-MIXED", "Mixed sensor modules", 1.56],
  ])("uses the supplied weight for %s", (sku, canonicalName, weight) => {
    expect(knownPartUnitWeightGrams({ sku, canonicalName })).toBe(weight);
  });

  it.each([6.2, 19, 47.12, 1.56])("detects two removed items using a %s g item weight", (knownUnitWeightGrams) => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 11,
      totalWeightGrams: 107 + 9 * knownUnitWeightGrams, knownUnitWeightGrams });
    expect(result).toMatchObject({ quantity: 9, verified: true,
      measurement: { tareWeightGrams: 107, unitWeightGrams: knownUnitWeightGrams } });
  });

  it("counts spacers from the scale even when vision reports 27", () => {
    expect(verifyPhysicalWeight({ ...reading, quantity: 27,
      totalWeightGrams: 292.03, knownUnitWeightGrams: 6.2 })).toMatchObject({
      quantity: 30, verified: true, measurement: { netWeightGrams: 185.03, unitWeightGrams: 6.2 },
    });
  });

  it("never derives item weight from the camera count", () => {
    for (const quantity of [null, 0, 1, 50]) {
      expect(verifyPhysicalWeight({ ...reading, quantity })).toMatchObject({
        quantity: 10, verified: true, measurement: { unitWeightGrams: 1.56 },
      });
    }
  });

  it("requires a supplied item weight instead of learning one", () => {
    expect(knownPartUnitWeightGrams({ sku: "UNKNOWN" })).toBeNull();
    for (const knownUnitWeightGrams of [null, 0, -1, NaN]) {
      expect(verifyPhysicalWeight({ ...reading, knownUnitWeightGrams })).toMatchObject({
        measurement: null, verified: false, quantity: null,
      });
    }
  });

  it.each([
    { totalWeightGrams: null }, { weightSource: "FALLBACK" },
    { totalWeightGrams: 100 }, { totalWeightGrams: NaN },
  ])("rejects missing or invalid physical readings: %j", (overrides) => {
    expect(verifyPhysicalWeight({ ...reading, ...overrides }).verified).toBe(false);
  });

  it("rejects readings between two possible quantities", () => {
    expect(verifyPhysicalWeight({ ...reading, totalWeightGrams: 107 + 9.5 * 1.56 }).verified).toBe(false);
  });

  it("counts an empty bin when the total equals the tare", () => {
    expect(verifyPhysicalWeight({ ...reading, totalWeightGrams: 107 })).toMatchObject({
      quantity: 0, verified: true, measurement: { netWeightGrams: 0, unitWeightGrams: 1.56 },
    });
  });

  it("uses the configured tare without changing the supplied item weight", () => {
    process.env.PUTAWAY_CONTAINER_TARE_GRAMS = "125.5";
    expect(configuredContainerTareGrams()).toBe(125.5);
    expect(verifyPhysicalWeight({ ...reading, totalWeightGrams: 125.5 + 10 * 1.56 })).toMatchObject({
      quantity: 10, verified: true, measurement: { tareWeightGrams: 125.5, unitWeightGrams: 1.56 },
    });
  });

  it("labels simulation and requires its explicitly supplied item weight", () => {
    expect(verifyPhysicalWeight({ ...reading, quantity: 9, simulated: true })).toMatchObject({
      quantity: 9, source: "SIMULATION", verified: true,
    });
    expect(verifyPhysicalWeight({ ...reading, simulated: true, knownUnitWeightGrams: null }).verified).toBe(false);
  });
});
