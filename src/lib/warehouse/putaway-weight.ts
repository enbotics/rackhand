const DEFAULT_CONTAINER_TARE_GRAMS = 107;

/** Measured reference weights supplied for the warehouse's stocked parts. */
export function knownPartUnitWeightGrams(part: {
  sku?: string | null;
  canonicalName?: string | null;
}): number | null {
  const sku = part.sku?.toUpperCase();
  if (sku === "HARDWARE-ROUND-SPACER") return 6.2;
  if (sku === "DRIVER-MKS-TMC2160-OC-V1") return 47.12;
  if (sku === "ELECTRONICS-SENSOR-MODULE-MIXED") return 1.56;
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

/** Count contents from a supplied unit weight; never learn weight from a count. */
export function verifyPhysicalWeight(input: {
  totalWeightGrams: number | null | undefined;
  quantity: number | null;
  weightSource: string | null | undefined;
  simulated: boolean;
  knownUnitWeightGrams: number | null;
}): {
  measurement: PutawayWeightMeasurement | null;
  verified: boolean;
  source: "SCALE" | "SIMULATION" | null;
  quantity: number | null;
} {
  const unavailable = { measurement: null, verified: false, source: null, quantity: null };
  const itemWeight = input.knownUnitWeightGrams;
  if (itemWeight == null || !Number.isFinite(itemWeight) || itemWeight <= 0) {
    return unavailable;
  }
  const tare = configuredContainerTareGrams();
  // Simulation synthesizes a reading only from an explicitly supplied item weight.
  if (input.simulated && (input.quantity == null || !Number.isInteger(input.quantity) || input.quantity < 0)) {
    return unavailable;
  }
  const total = input.simulated
    ? tare + itemWeight * input.quantity!
    : input.totalWeightGrams;
  if (total == null || !Number.isFinite(total) || total < tare
    || (!input.simulated && input.weightSource !== "SCALE")) {
    return unavailable;
  }
  const net = total - tare;
  const quantity = Math.round(net / itemWeight);
  // Reject readings near the boundary between two possible quantities.
  const verified = Math.abs(net - quantity * itemWeight) <= itemWeight * 0.45;
  return {
    measurement: {
      totalWeightGrams: roundedGrams(total),
      tareWeightGrams: tare,
      netWeightGrams: roundedGrams(net),
      unitWeightGrams: itemWeight,
    },
    verified,
    source: input.simulated ? "SIMULATION" : "SCALE",
    quantity,
  };
}
