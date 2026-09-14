/**
 * The retrieval contract (Milestone 8).
 *
 * Types only, no runtime code and no server-only imports — same rule as
 * putaway-types.ts, so a browser panel can render an outcome without Prisma.
 *
 * The mirror image of putaway, and deliberately NOT a reuse of it. Putaway
 * starts from a physical observation (a ScanResult) and ends in stock;
 * retrieval starts from authoritative catalog identity and ends with a whole
 * bin checked out. Sharing one "movement service" would force both flows through
 * preconditions that only make sense for one of them.
 */
/**
 * What the caller asks for.
 *
 * Identity is authoritative — never a name the model liked ("a 6204
 * bearing"). Natural-language interpretation happens BEFORE this boundary,
 * using the read-only tools; by the time a physical operation is requested,
 * the part must already be pinned down. There are two authoritative paths,
 * not one:
 *
 *   - sku/partId: catalog identity, resolved anywhere it is stocked.
 *   - sourceBinCode ALONE (sku and partId both omitted): spatial identity.
 *     A bin holds at most one SKU at a time — the same invariant
 *     get_bin_status already relies on — so naming a bin IS a deterministic
 *     identity, resolved by reading what that bin actually holds, never
 *     guessed. An empty bin fails cleanly rather than picking anything.
 *
 * Supplying both sku/partId AND sourceBinCode keeps today's meaning: the
 * catalog identity is authoritative and the bin is just where to take it
 * from, revalidated to actually hold that part.
 *
 * The gantry moves the entire physical bin to OUTPUT. Inventory quantity is
 * verified at checkout and again when that bin returns through putaway;
 * retrieval never guesses how many units the client will remove.
 */
export interface RetrievalRequest {
  /** Server-only compatibility policy. User-requested prep verifies checkout. */
  verifyContents?: boolean;
  sku?: string;
  partId?: string;
  /** Deprecated compatibility input. The physical operation always checks out the whole bin. */
  quantity?: number;
  /**
   * A specific bin to retrieve from. With sku/partId, just narrows where to
   * take it from. Alone (sku and partId both omitted), IS the identity —
   * the part is resolved from that bin's own contents. Omitted entirely
   * (with sku/partId given), the deterministic lowest-bin-code policy chooses.
   */
  sourceBinCode?: string;
  /**
   * Idempotency key. Supply a stable value and a retry returns the original
   * result instead of fetching a second item; omit it and the service
   * generates one, which makes the call safe but not deduplicable.
   */
  requestId?: string;
}

export const RETRIEVAL_DESTINATION = "OUTPUT" as const;

export const RETRIEVAL_FAILURE_REASONS = [
  "invalid_request",
  "part_not_found",
  "out_of_stock",
  /** Recorded stock is already at checkout, so no second retrieval is needed. */
  "source_bin_checked_out",
  "source_bin_not_found",
  /** Bin-only identity (no sku/partId given) resolved to a bin holding nothing. */
  "source_bin_empty",
  "source_inventory_mismatch",
  "inventory_conflict",
  "gantry_busy",
  "gantry_failed",
  "retrieval_commit_failed",
  "retrieval_verification_failed",
  /** Project addition, mirroring putaway_in_progress. */
  "retrieval_in_progress",
  /** Simulation mode is on and this bin isn't one of the two it covers. */
  "simulation_scope_violation",
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
  /** Last verified quantity travelling with the checked-out bin. */
  checkedOutQuantity: number;
  /** No authoritative quantity is removed until return-photo reconciliation. */
  inventoryQuantityRemoved: 0;
  /** Compatibility alias for the last verified count retained in the bin. */
  remainingQuantityInBin: number;
  binStatus: "CHECKED_OUT";
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
