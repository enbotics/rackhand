const DEFAULT_CONTAINER_TARE_GRAMS = 107;
const DEFAULT_FALLBACK_TOTAL_WEIGHT_GRAMS = 150;
const PER_ITEM_WEIGHT_TOLERANCE_GRAMS = 5;

/** Measured reference weights supplied for the warehouse's stocked parts. */
export function knownPartUnitWeightGrams(part: {
  sku?: string | null;
  canonicalName?: string | null;
}): number | null {
  const sku = part.sku?.toUpperCase();
  if (sku === "HARDWARE-ROUND-SPACER") return 6.2;
  if (sku === "DRIVER-MKS-TMC2160-OC-V1") return 47.12;
  if (part.canonicalName?.toLowerCase() === "v-groove bearing wheel hardware kit") return 19;
  return null;
}

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

/**
 * Calculate contents and per-item weight from one verified bin reading.
 *
 * A reading above the configured container tare is treated as a gross weight,
 * so the tare is subtracted. A reading at or below the tare is treated as an
 * already-tared scale reading and divided directly by the observed quantity.
 */
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

  const appliedTareWeightGrams =
    totalWeightGrams > tareWeightGrams ? tareWeightGrams : 0;
  const netWeightGrams = totalWeightGrams - appliedTareWeightGrams;

  return {
    totalWeightGrams: roundedGrams(totalWeightGrams),
    tareWeightGrams: roundedGrams(appliedTareWeightGrams),
    netWeightGrams: roundedGrams(netWeightGrams),
    unitWeightGrams: roundedGrams(netWeightGrams / quantity),
  };
}

/** A physical scale reading corroborates vision against a prior item weight.
 * First-time readings establish that reference; fallback weights are not evidence.
 * Allow up to 5 g of average weight variation per camera-counted item.
 * Empty bins retain their separate residual-weight check.
 */
export function verifyPhysicalWeight(input: {
  totalWeightGrams: number | null | undefined;
  quantity: number | null;
  weightSource: string | null | undefined;
  referenceUnitWeightGrams: number | null;
  simulated: boolean;
  expectedQuantity: number;
  knownUnitWeightGrams?: number | null;
}): { measurement: PutawayWeightMeasurement | null; verified: boolean; source: "SCALE" | "SIMULATION" | null; quantity?: number } {
  const knownUnitWeight = input.knownUnitWeightGrams;
  if (knownUnitWeight != null && Number.isFinite(knownUnitWeight) && knownUnitWeight > 0) {
    const tare = configuredContainerTareGrams();
    const total = input.simulated && input.quantity != null
      ? tare + knownUnitWeight * input.quantity
      : input.totalWeightGrams;
    if (total == null || !Number.isFinite(total) || total < tare
      || (!input.simulated && input.weightSource !== "SCALE")) {
      return { measurement: null, verified: false, source: null };
    }
    const net = total - tare;
    const quantity = Math.round(net / knownUnitWeight);
    // Reject readings near the boundary between two possible quantities.
    const verified = Math.abs(net - quantity * knownUnitWeight) <= knownUnitWeight * 0.45;
    return {
      measurement: {
        totalWeightGrams: roundedGrams(total),
        tareWeightGrams: tare,
        netWeightGrams: roundedGrams(net),
        unitWeightGrams: knownUnitWeight,
      },
      verified,
      source: input.simulated ? "SIMULATION" : "SCALE",
      quantity,
    };
  }
  if (input.quantity === null || !Number.isInteger(input.quantity) || input.quantity < 0) {
    return { measurement: null, verified: false, source: null };
  }
  const tare = configuredContainerTareGrams();
  const reference = input.referenceUnitWeightGrams;
  const simulatedUnitWeight = reference ?? Math.max(1,
    (configuredFallbackTotalWeightGrams() - tare) / Math.max(1, input.expectedQuantity));
  const total = input.simulated ? tare + simulatedUnitWeight * input.quantity : input.totalWeightGrams;
  if (total == null || !Number.isFinite(total) || total < 0 || (!input.simulated && input.weightSource !== "SCALE")) {
    return { measurement: null, verified: false, source: null };
  }
  const measurement = input.quantity === 0
    ? { totalWeightGrams: total, tareWeightGrams: total === 0 ? 0 : tare,
        netWeightGrams: Math.max(0, total - tare), unitWeightGrams: 0 }
    : total > 0 ? calculatePutawayWeight(total, input.quantity, tare) : null;
  const tolerance = input.quantity === 0
    ? Math.max(2, (reference ?? 0) * 0.5)
    : Math.max(2, PER_ITEM_WEIGHT_TOLERANCE_GRAMS * input.quantity);
  const verified = measurement !== null && (input.quantity === 0
    ? measurement.netWeightGrams <= tolerance
    : measurement.netWeightGrams > 0 && (reference === null
      || Math.abs(measurement.netWeightGrams - reference * input.quantity) <= tolerance));
  return { measurement, verified, source: input.simulated ? "SIMULATION" : "SCALE" };
}
