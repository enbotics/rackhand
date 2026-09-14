import { checkAuditScale } from "./audit-scale";
import { knownPartUnitWeightGrams } from "./putaway-weight";

export async function auditScaleCheck(input: {
  part: { sku: string; canonicalName: string } | null;
  totalWeightGrams?: number | null;
  weightSource?: string | null;
}) {
  return checkAuditScale(input, input.part ? knownPartUnitWeightGrams(input.part) : null);
}
