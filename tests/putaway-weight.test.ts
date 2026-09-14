import { afterEach, describe, expect, it } from "vitest";

import {
  calculatePutawayWeight,
  configuredContainerTareGrams,
  configuredFallbackTotalWeightGrams,
  verifyPhysicalWeight,
  knownPartUnitWeightGrams,
} from "@/lib/warehouse/putaway-weight";

const originalTare = process.env.PUTAWAY_CONTAINER_TARE_GRAMS;
const originalFallback = process.env.PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS;

afterEach(() => {
  if (originalTare === undefined) {
    delete process.env.PUTAWAY_CONTAINER_TARE_GRAMS;
  } else {
    process.env.PUTAWAY_CONTAINER_TARE_GRAMS = originalTare;
  }
  if (originalFallback === undefined) {
    delete process.env.PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS;
  } else {
    process.env.PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS = originalFallback;
  }
});

describe("camera and scale quantity checks", () => {
  const reading = { totalWeightGrams: 227, quantity: 12, weightSource: "SCALE",
    referenceUnitWeightGrams: 10, simulated: false, expectedQuantity: 12 };

  it.each([
    ["HARDWARE-ROUND-SPACER", "Round unthreaded spacer", 6.2],
    ["BEARING-KIT", "V-groove bearing wheel hardware kit", 19],
    ["DRIVER-MKS-TMC2160-OC-V1", "Motor driver", 47.12],
  ])("uses the supplied weight for %s", (sku, canonicalName, weight) => {
    expect(knownPartUnitWeightGrams({ sku, canonicalName })).toBe(weight);
  });

  it("counts spacers from the scale even when vision reports 27", () => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 27,
      totalWeightGrams: 292.03, knownUnitWeightGrams: 6.2 });
    expect(result).toMatchObject({ quantity: 30, verified: true,
      measurement: { netWeightGrams: 185.03, unitWeightGrams: 6.2 } });
  });

  it.each([6.2, 19, 47.12])("detects two removed items using a %s g item weight", (knownUnitWeightGrams) => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 11,
      expectedQuantity: 11, totalWeightGrams: 107 + 9 * knownUnitWeightGrams,
      knownUnitWeightGrams });
    expect(result.quantity).toBe(9);
    expect(result.verified).toBe(true);
  });

  it("rejects ambiguous, missing, fallback and below-tare fixed-weight readings", () => {
    for (const overrides of [{ totalWeightGrams: 107 + 9.5 * 6.2 },
      { totalWeightGrams: null }, { weightSource: "FALLBACK" },
      { totalWeightGrams: 100 }]) {
      expect(verifyPhysicalWeight({ ...reading, knownUnitWeightGrams: 6.2, ...overrides }).verified).toBe(false);
    }
    expect(verifyPhysicalWeight({ ...reading, quantity: 10, totalWeightGrams: 107,
      knownUnitWeightGrams: 6.2 })).toMatchObject({ quantity: 0, verified: true });
  });

  it("checks both the checkout count and the remaining return count", () => {
    expect(verifyPhysicalWeight(reading).verified).toBe(true);
    const returned = verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: 217 });
    expect(returned.verified).toBe(true);
    expect(returned.measurement?.unitWeightGrams).toBe(10);
  });

  it("does not trust a visual count when measured weight disagrees", () => {
    expect(verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: 287 }).verified).toBe(false);
  });

  it("accepts the B4-01 reading within 5 g per kit", () => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 10, expectedQuantity: 10,
      totalWeightGrams: 293.15, referenceUnitWeightGrams: 16.251 });
    expect(result.verified).toBe(true);
    expect(result.measurement?.unitWeightGrams).toBe(18.615);
  });

  it.each([
    [287, true], // Exactly 5 g heavier per item.
    [167, true], // Exactly 5 g lighter per item.
    [287.012, false], // More than 5 g heavier per item.
    [166.988, false], // More than 5 g lighter per item.
  ])("checks the inclusive 5 g per-item boundary for a %s g reading", (totalWeightGrams, verified) => {
    expect(verifyPhysicalWeight({ ...reading, totalWeightGrams }).verified).toBe(verified);
  });

  it("does not treat a missing scale or synthetic fallback as measured evidence", () => {
    expect(verifyPhysicalWeight({ ...reading, totalWeightGrams: null }).verified).toBe(false);
    expect(verifyPhysicalWeight({ ...reading, weightSource: "FALLBACK" }).verified).toBe(false);
  });

  it("establishes an item-weight reference on the first measured check", () => {
    const result = verifyPhysicalWeight({ ...reading, referenceUnitWeightGrams: null });
    expect(result.verified).toBe(true);
    expect(result.measurement?.unitWeightGrams).toBe(10);
  });

  it("supports an empty returned bin but not a bin with unexplained weight", () => {
    expect(verifyPhysicalWeight({ ...reading, quantity: 0, totalWeightGrams: 107 }).verified).toBe(true);
    expect(verifyPhysicalWeight({ ...reading, quantity: 0, totalWeightGrams: 127 }).verified).toBe(false);
  });

  it("labels browser-simulation readings as simulation, not a physical scale", () => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: null, simulated: true });
    expect(result.source).toBe("SIMULATION");
    expect(result.verified).toBe(true);
    expect(result.measurement?.netWeightGrams).toBe(110);
  });
});

describe("putaway weight", () => {
  it("subtracts the 107 g box and divides the net weight by quantity", () => {
    expect(calculatePutawayWeight(407, 3)).toEqual({
      totalWeightGrams: 407,
      tareWeightGrams: 107,
      netWeightGrams: 300,
      unitWeightGrams: 100,
    });
  });

  it("keeps enough precision for non-even batches", () => {
    expect(calculatePutawayWeight(200, 3).unitWeightGrams).toBe(31);
  });

  it("supports a configured container tare", () => {
    process.env.PUTAWAY_CONTAINER_TARE_GRAMS = "125.5";
    expect(configuredContainerTareGrams()).toBe(125.5);
    expect(calculatePutawayWeight(225.5, 2).unitWeightGrams).toBe(50);
  });

  it("uses a reading equal to the tare as an already-tared item total", () => {
    expect(calculatePutawayWeight(107, 2)).toEqual({
      totalWeightGrams: 107,
      tareWeightGrams: 0,
      netWeightGrams: 107,
      unitWeightGrams: 53.5,
    });
  });

  it("divides a reading below the tare directly by quantity", () => {
    expect(calculatePutawayWeight(100, 4)).toEqual({
      totalWeightGrams: 100,
      tareWeightGrams: 0,
      netWeightGrams: 100,
      unitWeightGrams: 25,
    });
  });

  it("uses a configurable 150 g server fallback total", () => {
    expect(configuredFallbackTotalWeightGrams()).toBe(150);
    process.env.PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS = "175.5";
    expect(configuredFallbackTotalWeightGrams()).toBe(175.5);
  });
});
