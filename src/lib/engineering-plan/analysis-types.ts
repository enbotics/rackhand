export type TodayPlanAnalysisStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_ISSUES"
  | "FAILED";

export type TodayPlanAnalysisStage =
  | "QUEUED"
  | "READING_SHEET"
  | "PLANNING_MATERIALS"
  | "CHECKING_EVIDENCE"
  | "AUDITING_BIN"
  | "COMPLETE";

export interface TodayPlanRowView {
  planId: string;
  project: string;
  buildTask: string;
  priority: string;
  status: string;
}

export interface TodayPlanRequirementView {
  sku: string;
  purpose: string;
  category: string;
  quantity: number;
}

export interface TodayPlanAnalysisEventView {
  id: string;
  sequence: number;
  stage: string;
  status: string;
  summary: string;
  createdAt: number;
}

export interface TodayPlanAnalysisResultView {
  readiness:
    | "READY"
    | "PARTIALLY_READY"
    | "SHORTAGE"
    | "REVIEW_REQUIRED"
    | "NO_PLAN"
    | "NO_MATERIALS";
  message: string;
  selectedBins: Array<{
    sku: string;
    binCode: string;
    recordedQuantity: number;
    requiredQuantity: number;
  }>;
  shortages: Array<{ sku: string; required: number; available: number }>;
  auditedBinCodes: string[];
  verificationAuditRunIds: string[];
  auditIssues: Array<{
    binCode: string;
    expectedQuantity: number;
    observedQuantity: number | null;
    confidencePercent: number | null;
    reason: string;
  }>;
  scanSkips: Array<{
    sku: string;
    binCode: string;
    lastVerifiedAt: string | null;
    reason: string;
  }>;
}

export interface TodayPlanAnalysisRunView {
  id: string;
  status: TodayPlanAnalysisStatus;
  stage: TodayPlanAnalysisStage;
  workDate: string;
  rowsFound: number;
  currentBinCode: string | null;
  rows: TodayPlanRowView[];
  requirements: TodayPlanRequirementView[];
  result: TodayPlanAnalysisResultView | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  events: TodayPlanAnalysisEventView[];
}
