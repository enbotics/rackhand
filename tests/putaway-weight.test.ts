import { afterEach, describe, expect, it } from "vitest";

import {
  calculatePutawayWeight,
  configuredContainerTareGrams,
  configuredFallbackTotalWeightGrams,
  verifyPhysicalWeight,
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
  const reading = { totalWeightGrams: 237, quantity: 12, weightSource: "SCALE",
    referenceUnitWeightGrams: 10, simulated: false, expectedQuantity: 12 };

  it("checks both the checkout count and the remaining return count", () => {
    expect(verifyPhysicalWeight(reading).verified).toBe(true);
    const returned = verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: 227 });
    expect(returned.verified).toBe(true);
    expect(returned.measurement?.unitWeightGrams).toBe(10);
  });

  it("does not trust a visual count when measured weight disagrees", () => {
    expect(verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: 287 }).verified).toBe(false);
  });

  it("accepts the B4-01 reading within 5 g per kit", () => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 10, expectedQuantity: 10,
      totalWeightGrams: 303.15, referenceUnitWeightGrams: 16.251 });
    expect(result.verified).toBe(true);
    expect(result.measurement?.unitWeightGrams).toBe(18.615);
  });

  it.each([
    [297, true], // Exactly 5 g heavier per item.
    [177, true], // Exactly 5 g lighter per item.
    [297.012, false], // More than 5 g heavier per item.
    [176.988, false], // More than 5 g lighter per item.
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
    expect(verifyPhysicalWeight({ ...reading, quantity: 0, totalWeightGrams: 117 }).verified).toBe(true);
    expect(verifyPhysicalWeight({ ...reading, quantity: 0, totalWeightGrams: 137 }).verified).toBe(false);
  });

  it("labels browser-simulation readings as simulation, not a physical scale", () => {
    const result = verifyPhysicalWeight({ ...reading, quantity: 11, totalWeightGrams: null, simulated: true });
    expect(result.source).toBe("SIMULATION");
    expect(result.verified).toBe(true);
    expect(result.measurement?.netWeightGrams).toBe(110);
  });
});

describe("putaway weight", () => {
  it("subtracts the 117 g box and divides the net weight by quantity", () => {
    expect(calculatePutawayWeight(417, 3)).toEqual({
      totalWeightGrams: 417,
      tareWeightGrams: 117,
      netWeightGrams: 300,
      unitWeightGrams: 100,
    });
  });

  it("keeps enough precision for non-even batches", () => {
    expect(calculatePutawayWeight(200, 3).unitWeightGrams).toBe(27.667);
  });

  it("supports a configured container tare", () => {
    process.env.PUTAWAY_CONTAINER_TARE_GRAMS = "125.5";
    expect(configuredContainerTareGrams()).toBe(125.5);
    expect(calculatePutawayWeight(225.5, 2).unitWeightGrams).toBe(50);
  });

  it("uses a reading equal to the tare as an already-tared item total", () => {
    expect(calculatePutawayWeight(117, 2)).toEqual({
      totalWeightGrams: 117,
      tareWeightGrams: 0,
      netWeightGrams: 117,
      unitWeightGrams: 58.5,
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
