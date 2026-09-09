/** Mirrors putaway-capture-types.ts — same comparison UI, same decision shape. */
export const AUDIT_CAPTURE_CONFIDENCE_THRESHOLD = 0.8;

export type AuditCaptureOutcome =
  /** Observed matches recorded. No inventory write; just closes the audit out. */
  | "VERIFIED"
  /** Observed is higher. Safe, no human decision needed — inventory updates automatically. */
  | "AUTO_RECONCILED"
  /** Observed is lower. Safe otherwise, but a human must explicitly confirm before it writes. */
  | "REVIEW_DECREASE"
  /** Uncountable, confidence at/under 80%, MEDIUM/HIGH occlusion, or expected-part identity uncertain. */
  | "LOW_CONFIDENCE"
  | "CAPACITY_EXCEEDED"
  | "FOREIGN_OBJECTS";

export interface AuditCaptureView {
  captureId: string;
  binCode: string;
  status: string;
  outcome: AuditCaptureOutcome;
  expectedQuantity: number;
  observedQuantity: number | null;
  confidencePercent: number | null;
  previousImageUrl: string | null;
  currentImageUrl: string | null;
  foreignObjects: string[];
  notes: string | null;
}

export type AuditCaptureDecision = "ACCEPT" | "RETRY";
