/**
 * Client-side session state for the command centre (Milestone 10).
 *
 * Types only. This is the state of one operator's SESSION — what they just
 * scanned, what the server said about it — and never a mirror of warehouse
 * truth. Bins, inventory and movements are not in here on purpose: they come
 * from /api/warehouse/overview on every read, so nothing on screen can drift
 * away from the database.
 */
import type { Measurement } from "@/lib/shots-db";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import type { CatalogMatchResult } from "@/lib/warehouse/catalog-match-types";
import type { ResolutionCandidate } from "@/lib/warehouse/catalog-resolution-types";
import type { ScanFailure } from "@/lib/warehouse/dashboard-presentation";

/** Where the scan pipeline currently is. Each step is shown, never guessed at. */
export type ScanPhase = "EMPTY" | "MEASURING" | "MATCHING" | "READY" | "FAILED";

export interface CurrentScan {
  /** Links back to the local shot record in IndexedDB. */
  shotId: string;
  capturedAt: number;
  measurement: Measurement | null;
  /**
   * Null when the measurement did not satisfy the ScanResult contract. The
   * measurement still shows, but the scan cannot be used as warehouse
   * evidence — a person must not override broken measurement.
   */
  scanResult: ScanResult | null;
  /** Why the ScanResult conversion was rejected, when it was. */
  issues: string[];
  match: CatalogMatchResult | null;
  matchError: string | null;
}

/** A pending M9 identity decision, opened server-side for an AMBIGUOUS scan. */
export interface PendingIdentification {
  resolutionId: string;
  scanId: string;
  reason: string;
  expiresAt: string;
  candidates: ResolutionCandidate[];
}

/**
 * An identity a person took responsibility for. Kept separate from a matcher
 * result all the way to the screen, so "human confirmed" never renders as
 * "matched".
 */
export interface ConfirmedIdentity {
  resolutionId: string;
  scanId: string;
  partId: string;
  sku: string;
  canonicalName: string;
}

export interface ScanState {
  phase: ScanPhase;
  scan: CurrentScan | null;
  failure: ScanFailure | null;
}

/** One turn in the operator/agent transcript. Never model reasoning. */
export interface AgentTurn {
  id: string;
  role: "operator" | "agent" | "system";
  text: string;
  /** Tool names the model actually called. Operational trace only. */
  tools?: string[];
}

export interface ApprovalSummaryView {
  action: string;
  sku: string | null;
  canonicalName: string | null;
  source: string | null;
  destination: string | null;
  quantity: number | null;
  scope?: "COUNTED_UNITS" | "ENTIRE_BIN" | "AUDIT_BINS" | "MATERIALS_PLAN";
  capacity?: { before: number; after: number; limit: number } | null;
  /** See ApprovalSummary.autoSuggested server-side. */
  autoSuggested?: boolean;
  /** Remaining server-selected bins in the approved materials job. */
  fulfillmentQueue?: string[];
  /** Stable total bin count for progress across retrieval/return hops. */
  fulfillmentTotal?: number;
}

export interface PendingApprovalView {
  approvalId: string;
  action: string;
  summary: ApprovalSummaryView;
  expiresAt: string;
}

/**
 * What happened AFTER a decision was submitted.
 *
 * `EXECUTING` is set on submit; every other value comes back from the server.
 * A click never produces `COMPLETED` — see approval-card.tsx.
 */
export type ApprovalOutcomeKind =
  | "DECIDING"
  | "EXECUTING"
  | "SETTLED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED";

export interface ApprovalOutcome {
  kind: ApprovalOutcomeKind;
  summary: ApprovalSummaryView | null;
  /** Server-authored text. */
  message: string;
}
