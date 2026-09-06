/**
 * The retrieval contract (Milestone 8).
 *
 * Types only, no runtime code and no server-only imports — same rule as
 * putaway-types.ts, so a browser panel can render an outcome without Prisma.
 *
 * The mirror image of putaway, and deliberately NOT a reuse of it. Putaway
 * starts from a physical observation (a ScanResult) and ends in stock;
 * retrieval starts from authoritative catalog identity and ends with stock
 * removed. Sharing one "movement service" would force both flows through
 * preconditions that only make sense for one of them.
 */
/**
 * What the caller asks for.
 *
 * Identity is authoritative — a SKU or an internal part id, never free text.
 * Natural-language interpretation ("a 6204 bearing") happens BEFORE this
 * boundary, using the read-only tools; by the time a physical operation is
 * requested, the part must already be pinned down.
 *
 * Quantity is absent because it is fixed at 1: the gantry moves one physical
 * item per operation, and a bulk workflow is a later milestone. Destination is
 * absent because it is fixed at OUTPUT.
 */
export interface RetrievalRequest {
  sku?: string;
  partId?: string;
  /**
   * How many items the CALLER was asked for — not how many to move.
   *
   * The gantry moves one item per operation, so anything other than 1 is
   * refused outright. It exists so an agent must declare the quantity it is
   * acting on: a prompt rule saying "do not retrieve when three are requested"
   * is advice a model can forget, whereas a declared 3 is refused here every
   * time. Omitted means 1.
   */
  quantity?: number;
  /** Optional. Omitted means the deterministic lowest-bin-code policy chooses. */
  sourceBinCode?: string;
  /**
   * Idempotency key. Supply a stable value and a retry returns the original
   * result instead of fetching a second item; omit it and the service
   * generates one, which makes the call safe but not deduplicable.
   */
  requestId?: string;
}

export const RETRIEVAL_QUANTITY = 1;
export const RETRIEVAL_DESTINATION = "OUTPUT" as const;

export const RETRIEVAL_FAILURE_REASONS = [
  "invalid_request",
  /** More than one item was requested; the gantry moves one per operation. */
  "unsupported_quantity",
  "part_not_found",
  "out_of_stock",
  "source_bin_not_found",
  "source_inventory_mismatch",
  "inventory_conflict",
  "gantry_busy",
  "gantry_failed",
  "retrieval_commit_failed",
  /** Project addition, mirroring putaway_in_progress. */
  "retrieval_in_progress",
] as const;
export type RetrievalFailureReason = (typeof RETRIEVAL_FAILURE_REASONS)[number];

export interface RetrievalSuccess {
  ok: true;
  requestId: string;
  part: { partId: string; sku: string; canonicalName: string };
  sourceBinCode: string;
  destination: typeof RETRIEVAL_DESTINATION;
  movementId: string;
  gantryOperationId: string;
  /** 1 for a retrieval this call performed; 0 when replaying a completed one. */
  inventoryQuantityRemoved: 0 | 1;
  /** Stock left in the source bin afterwards. 0 means the bin is now AVAILABLE. */
  remainingQuantityInBin: number;
  status: "COMPLETED";
  /** True when this requestId had already been retrieved and nothing new ran. */
  duplicate?: boolean;
}

export interface RetrievalFailure {
  ok: false;
  reason: RetrievalFailureReason;
  requestId: string;
  /** Operator-facing, safe to display. Never a stack trace or internal detail. */
  message: string;
  movementId?: string;
  gantryOperationId?: string;
  /** Kept for reconciliation when a commit failed after the gantry moved. */
  sourceBinCode?: string;
  partId?: string;
  /** The GantryFailureKind, present for gantry_failed. */
  error?: string;
}

export type RetrievalResult = RetrievalSuccess | RetrievalFailure;
