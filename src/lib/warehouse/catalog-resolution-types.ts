/**
 * Human catalog-identity resolution (Milestone 9).
 *
 * Types only, no runtime code and no server-only imports.
 *
 * THE ARCHITECTURAL POINT: a machine match result and a human resolution are
 * different things and must never collapse into one. The deterministic matcher
 * stays authoritative about machine confidence — it never turns AMBIGUOUS into
 * MATCHED. A resolution records that a person took responsibility for the
 * identity instead. Every stored unit of stock therefore keeps its provenance:
 * the warehouse can always say whether an identity came from measurement or
 * from a human judgement call.
 */
import type { CatalogMatchAlternative } from "./catalog-match-types";

export const RESOLUTION_STATUSES = ["PENDING", "CONFIRMED", "REJECTED", "EXPIRED"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

/** Short by design: a stale identity decision is worse than asking again. */
export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

/** One option offered to the operator, with the evidence behind it. */
export interface ResolutionCandidate {
  partId: string;
  sku: string;
  canonicalName: string;
  confidence: number;
  dimensions: { lengthMM: number | null; widthMM: number | null; heightMM: number | null };
  evidence: CatalogMatchAlternative["evidence"];
  /** The part's representative photo, or null if it has none — a human picks by sight, not by SKU. */
  imageUrl: string | null;
}

export type CatalogResolutionRequestResult =
  /** The matcher was confident; no human decision is needed or offered. */
  | { status: "MATCHED"; partId: string; sku: string; canonicalName: string; confidence: number }
  /**
   * No plausible candidates. Deliberately NOT resolvable: offering a list to
   * pick from when the matcher found nothing would be inviting a guess, and
   * registering a new part is a separate workflow.
   */
  | { status: "NO_MATCH"; reason: string }
  | {
      status: "HUMAN_DECISION_REQUIRED";
      resolutionId: string;
      scanId: string;
      reason: string;
      expiresAt: string;
      candidates: ResolutionCandidate[];
    }
  /** The scan itself is unusable; a person must not override bad measurement. */
  | { status: "RESCAN_REQUIRED"; issues: string[] };

export interface CatalogResolutionView {
  resolutionId: string;
  scanId: string;
  status: ResolutionStatus;
  originalMatchStatus: string;
  selectedPartId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export type ResolutionDecisionResult =
  | { ok: true; resolution: CatalogResolutionView }
  | {
      ok: false;
      reason:
        | "resolution_not_found"
        | "resolution_not_pending"
        | "resolution_expired"
        | "candidate_not_allowed"
        | "part_not_found";
      message: string;
    };

/**
 * Where a putaway's part identity came from. Kept on purpose: erasing the
 * difference would make a human judgement indistinguishable from a measured
 * match in the audit trail.
 */
export type EffectiveCatalogIdentity =
  | { source: "DETERMINISTIC_MATCH"; partId: string }
  | { source: "HUMAN_RESOLUTION"; partId: string; resolutionId: string };
