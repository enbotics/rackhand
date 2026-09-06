/**
 * The putaway contract (Milestone 7).
 *
 * Types only, no runtime code and no server-only imports, so a browser panel
 * can render a putaway outcome without pulling in Prisma — same rule as
 * scan-types.ts and catalog-match-types.ts.
 *
 * Every outcome is a value, not an exception. A putaway that cannot proceed is
 * an ordinary, expected answer ("that bin is taken", "the match is ambiguous"),
 * and the caller — a route, a test, or the agent — needs the reason in a form
 * it can act on rather than a stack trace.
 */
import type { CatalogMatchAlternative } from "./catalog-match-types";
import type { EffectiveCatalogIdentity } from "./catalog-resolution-types";
import type { ScanResult } from "./scan-types";

/**
 * What the caller asks for. Deliberately small.
 *
 * The scanner represents ONE physical item standing at the intake station, so
 * quantity is fixed at 1 and the source is fixed at INTAKE by the workflow —
 * neither is a caller's (or a model's) choice. Movement status and inventory
 * deltas are likewise absent: those are consequences the service derives, not
 * inputs it accepts.
 */
export interface PutawayRequest {
  scanResult: ScanResult;
  /** Optional. Omitted means the deterministic findAvailableBin policy picks one. */
  destinationBinCode?: string;
  /**
   * A CONFIRMED human identity decision (Milestone 9), required when the
   * matcher returns AMBIGUOUS. It only settles WHICH part this is; every other
   * precondition — bin, gantry, idempotency, reservation — is revalidated as
   * usual. Never trusted on the strength of an id alone: the service reloads
   * it, checks the status, the expiry and that it belongs to this exact scan.
   */
  catalogResolutionId?: string;
}

export const PUTAWAY_QUANTITY = 1;
export const PUTAWAY_SOURCE = "INTAKE" as const;

export const PUTAWAY_FAILURE_REASONS = [
  "invalid_scan",
  "catalog_match_ambiguous",
  "catalog_no_match",
  "part_not_found",
  "no_available_bin",
  "bin_not_found",
  "bin_unavailable",
  "bin_reservation_conflict",
  "gantry_busy",
  "gantry_failed",
  "putaway_commit_failed",
  /** Project addition: the same scan is already mid-putaway. */
  "putaway_in_progress",
  /** A supplied catalog resolution was missing, unconfirmed, expired or for another scan. */
  "catalog_resolution_invalid",
] as const;
export type PutawayFailureReason = (typeof PUTAWAY_FAILURE_REASONS)[number];

export interface PutawaySuccess {
  ok: true;
  scanId: string;
  part: { partId: string; sku: string; canonicalName: string };
  destinationBinCode: string;
  movementId: string;
  gantryOperationId: string;
  /**
   * 1 for a putaway this call performed; 0 when replaying an already-completed
   * scan. Reporting 1 on a replay would misstate what happened — the point of
   * idempotency is that the second call adds nothing.
   */
  inventoryQuantityAdded: 0 | 1;
  status: "COMPLETED";
  /**
   * Whether this part's identity came from measurement or from a person
   * resolving an ambiguous scan. Kept so the audit trail never loses the
   * difference between the two.
   */
  identity: EffectiveCatalogIdentity;
  /** True when this scan had already been put away and nothing new executed. */
  duplicate?: boolean;
}

export interface PutawayFailure {
  ok: false;
  reason: PutawayFailureReason;
  scanId: string;
  /** Operator-facing, safe to display. Never a stack trace or internal detail. */
  message: string;
  /** Present once a Movement exists — kept for reconciliation. */
  movementId?: string;
  gantryOperationId?: string;
  /** Present for catalog_match_ambiguous, so an operator can see the tie. */
  candidates?: CatalogMatchAlternative[];
  /** The GantryFailureKind, present for gantry_failed. */
  error?: string;
}

export type PutawayResult = PutawaySuccess | PutawayFailure;
