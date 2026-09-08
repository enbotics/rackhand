export const AUDIT_AUTO_RECONCILE_CONFIDENCE = 0.8;
// Allows one initial analysis plus one GoalLoop refinement of the same frame.
export const AUDIT_CAPTURE_TIMEOUT_MS = 75_000;

export type AuditOcclusion = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface AuditVisionResult {
  countable: boolean;
  observedCount: number | null;
  /** Canonical 0..1 value. Operator-facing UI renders this as a percentage. */
  countConfidence: number;
  expectedPartPresent: boolean;
  foreignObjectSuspected: boolean;
  occlusion: AuditOcclusion;
  notes: string;
}

export type BinAuditOutcomeStatus =
  | "VERIFIED"
  | "AUTO_RECONCILED"
  | "REVIEW_REQUIRED"
  /** A human reviewed a pending observation and applied its count. */
  | "CONFIRMED"
  /** A human reviewed a pending observation and declined to apply it. */
  | "DISMISSED"
  | "FAILED";

export interface BinAuditResult {
  binAuditId: string;
  binCode: string;
  status: BinAuditOutcomeStatus;
  expectedQuantity: number;
  observedQuantity: number | null;
  confidence: number | null;
  confidencePercent: number | null;
  inventoryUpdated: boolean;
  previousQuantity: number | null;
  newQuantity: number | null;
  evidenceUrl: string | null;
  reason?: string;
}

export interface InventoryAuditRunResult {
  auditRunId: string;
  status: "COMPLETED" | "COMPLETED_WITH_ISSUES" | "FAILED";
  binsPlanned: number;
  binsCompleted: number;
  verifiedBins: number;
  reconciledBins: number;
  reviewRequiredBins: number;
  failedBins: number;
  results: BinAuditResult[];
}

export function confidencePercent(confidence: number): number {
  return Math.round(confidence * 10_000) / 100;
}

export function isAuditVisionResult(value: unknown): value is AuditVisionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const count = item.observedCount;
  return (
    typeof item.countable === "boolean" &&
    (count === null || (typeof count === "number" && Number.isInteger(count) && count >= 0)) &&
    typeof item.countConfidence === "number" &&
    Number.isFinite(item.countConfidence) &&
    item.countConfidence >= 0 &&
    item.countConfidence <= 1 &&
    typeof item.expectedPartPresent === "boolean" &&
    typeof item.foreignObjectSuspected === "boolean" &&
    ["NONE", "LOW", "MEDIUM", "HIGH"].includes(String(item.occlusion)) &&
    typeof item.notes === "string"
  );
}
