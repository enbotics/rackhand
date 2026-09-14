import { verifyPhysicalWeight } from "./putaway-weight";

export interface AuditScaleCheck {
  status: "VERIFIED" | "MISMATCH" | "UNAVAILABLE";
  totalWeightGrams: number | null;
  estimatedQuantity: number | null;
}

/** Audit quantity uses the physical reading and a supplied item weight. */
export function checkAuditScale(
  reading: { totalWeightGrams?: number | null; weightSource?: string | null },
  knownUnitWeightGrams: number | null,
): AuditScaleCheck {
  const scale = verifyPhysicalWeight({
    totalWeightGrams: reading.totalWeightGrams, weightSource: reading.weightSource,
    quantity: null, simulated: false, knownUnitWeightGrams,
  });
  return {
    status: scale.verified ? "VERIFIED" : scale.measurement ? "MISMATCH" : "UNAVAILABLE",
    totalWeightGrams: scale.measurement?.totalWeightGrams ?? null,
    estimatedQuantity: scale.verified ? scale.quantity : null,
  };
}
