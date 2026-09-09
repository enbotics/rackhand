export const PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD = 0.8;

export type PutawayCaptureOutcome =
  | "READY"
  | "INCREASED"
  | "REVIEW_DECREASE"
  | "LOW_CONFIDENCE"
  | "CAPACITY_EXCEEDED"
  | "FOREIGN_OBJECTS";

export interface PutawayCaptureView {
  captureId: string;
  binCode: string;
  status: string;
  outcome: PutawayCaptureOutcome;
  expectedQuantity: number;
  observedQuantity: number | null;
  confidencePercent: number | null;
  previousImageUrl: string | null;
  currentImageUrl: string | null;
  foreignObjects: string[];
  notes: string | null;
}

export type PutawayCaptureDecision = "ACCEPT" | "RETRY";
