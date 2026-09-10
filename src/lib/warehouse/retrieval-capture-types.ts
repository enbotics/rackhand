/** Mirrors putaway-capture-types.ts — same comparison UI, same decision shape. */
export const RETRIEVAL_CAPTURE_CONFIDENCE_THRESHOLD = 0.8;

export type RetrievalCaptureOutcome =
  | "READY"
  | "INCREASED"
  | "REVIEW_DECREASE"
  | "ANALYSIS_FAILED"
  | "LOW_CONFIDENCE"
  | "CAPACITY_EXCEEDED"
  | "FOREIGN_OBJECTS";

export interface RetrievalCaptureView {
  captureMode: "PROD" | "SIMULATION";
  captureId: string;
  binCode: string;
  status: string;
  outcome: RetrievalCaptureOutcome;
  expectedQuantity: number;
  observedQuantity: number | null;
  confidencePercent: number | null;
  previousImageUrl: string | null;
  currentImageUrl: string | null;
  foreignObjects: string[];
  notes: string | null;
}

export type RetrievalCaptureDecision = "ACCEPT" | "RETRY" | "CANCEL";
