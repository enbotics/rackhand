import { afterEach, describe, expect, it } from "vitest";

import {
  calculatePutawayWeight,
  configuredContainerTareGrams,
  configuredFallbackTotalWeightGrams,
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
