export interface AuditScaleCheck {
  status: "AGREES" | "MISMATCH" | "UNAVAILABLE";
  totalWeightGrams: number | null;
  estimatedQuantity: number | null;
}

/** Cross-check a camera count against a previous physical item-weight measurement. */
export function checkAuditScale(
  observedQuantity: number | null,
  reading: { totalWeightGrams?: number | null; weightSource?: string | null },
  baseline: { unitWeightGrams: number | null; tareWeightGrams: number | null; weightSource: string | null } | null,
): AuditScaleCheck {
  const total = reading.weightSource === "SCALE" ? reading.totalWeightGrams ?? null : null;
  if (total === null || !Number.isFinite(total) || total <= 0 || observedQuantity === null ||
      !baseline || baseline.weightSource !== "SCALE" ||
      baseline.unitWeightGrams === null || !Number.isFinite(baseline.unitWeightGrams) || baseline.unitWeightGrams <= 0 ||
      baseline.tareWeightGrams === null || !Number.isFinite(baseline.tareWeightGrams) || baseline.tareWeightGrams < 0) {
    return { status: "UNAVAILABLE", totalWeightGrams: total, estimatedQuantity: null };
  }
  const net = total - baseline.tareWeightGrams;
  const estimatedQuantity = Math.max(0, Math.round(net / baseline.unitWeightGrams));
  // Allow half an item's mass for sensor noise/rounding; never silently replace the camera count.
  const agrees = net >= 0 && Math.abs(net - observedQuantity * baseline.unitWeightGrams) <= baseline.unitWeightGrams / 2;
  return { status: agrees ? "AGREES" : "MISMATCH", totalWeightGrams: total, estimatedQuantity };
}
