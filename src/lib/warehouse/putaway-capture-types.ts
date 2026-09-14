/** Putaway requires more than 60% confidence; exactly 60% still needs review. */
export const PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD = 0.6;

export type PutawayCaptureOutcome =
  | "READY"
  | "INCREASED"
  | "REVIEW_DECREASE"
  | "ANALYSIS_FAILED"
  | "LOW_CONFIDENCE"
  | "CAPACITY_EXCEEDED"
  | "FOREIGN_OBJECTS";

export interface PutawayCaptureView {
  operation?: "RETRIEVAL" | "PUTAWAY";
  isReturn?: boolean;
  captureMode: "PROD" | "SIMULATION";
  captureId: string;
  binCode: string;
  status: string;
  outcome: PutawayCaptureOutcome;
  expectedQuantity: number;
  observedQuantity: number | null;
  quantitySource?: "SCALE" | "VISION";
  confidencePercent: number | null;
  /** Gross bin weight from the USB scale, including the container. */
  totalWeightGrams: number | null;
  tareWeightGrams: number | null;
  netWeightGrams: number | null;
  unitWeightGrams: number | null;
  weightSource: "SCALE" | "FALLBACK" | "SIMULATION" | null;
  previousImageUrl: string | null;
  currentImageUrl: string | null;
  foreignObjects: string[];
  notes: string | null;
}

export type PutawayCaptureDecision =
  | "ACCEPT"
  | "AUTO_RETURN"
  | "RETRY"
  | "CANCEL";
