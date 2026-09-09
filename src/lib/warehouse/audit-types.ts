export type AuditOcclusion = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface AuditVisionResult {
  countable: boolean;
  observedCount: number | null;
  /** Canonical 0..1 value. Operator-facing UI renders this as a percentage. */
  countConfidence: number;
  expectedPartPresent: boolean;
  foreignObjectSuspected: boolean;
  /** Short visible names such as "washer" or "red cable"; empty when none. */
  foreignObjects?: string[];
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
