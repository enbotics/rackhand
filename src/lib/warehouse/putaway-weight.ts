const DEFAULT_CONTAINER_TARE_GRAMS = 117;
const DEFAULT_FALLBACK_TOTAL_WEIGHT_GRAMS = 150;

export interface PutawayWeightMeasurement {
  totalWeightGrams: number;
  tareWeightGrams: number;
  netWeightGrams: number;
  unitWeightGrams: number;
}

export class PutawayWeightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PutawayWeightError";
  }
}

function roundedGrams(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function configuredContainerTareGrams(): number {
  const value = Number(
    process.env.PUTAWAY_CONTAINER_TARE_GRAMS ?? DEFAULT_CONTAINER_TARE_GRAMS,
  );
  if (!Number.isFinite(value) || value < 0) {
    throw new PutawayWeightError(
      "PUTAWAY_CONTAINER_TARE_GRAMS must be a non-negative number.",
    );
  }
  return roundedGrams(value);
}

export function configuredFallbackTotalWeightGrams(): number {
  const value = Number(
    process.env.PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS ??
      DEFAULT_FALLBACK_TOTAL_WEIGHT_GRAMS,
  );
  if (!Number.isFinite(value) || value <= 0) {
    throw new PutawayWeightError(
      "PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS must be a positive number.",
    );
  }
  return roundedGrams(value);
}

/** Calculate contents and per-item weight from one verified bin reading. */
export function calculatePutawayWeight(
  totalWeightGrams: number,
  quantity: number,
  tareWeightGrams = configuredContainerTareGrams(),
): PutawayWeightMeasurement {
  if (!Number.isFinite(totalWeightGrams) || totalWeightGrams <= 0) {
    throw new PutawayWeightError("The scale total must be a positive number.");
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new PutawayWeightError(
      "A positive camera-confirmed quantity is required to calculate item weight.",
    );
  }
  if (!Number.isFinite(tareWeightGrams) || tareWeightGrams < 0) {
    throw new PutawayWeightError("The container tare must be non-negative.");
  }

  const netWeightGrams = totalWeightGrams - tareWeightGrams;
  if (netWeightGrams <= 0) {
    throw new PutawayWeightError(
      `The scale total must be greater than the ${roundedGrams(tareWeightGrams)} g container tare.`,
    );
  }

  return {
    totalWeightGrams: roundedGrams(totalWeightGrams),
    tareWeightGrams: roundedGrams(tareWeightGrams),
    netWeightGrams: roundedGrams(netWeightGrams),
    unitWeightGrams: roundedGrams(netWeightGrams / quantity),
  };
}
