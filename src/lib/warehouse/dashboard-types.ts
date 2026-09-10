/**
 * The read model the command-center dashboard renders (Milestone 10).
 *
 * Types only, no runtime code and no server-only imports — same rule as
 * scan-types.ts and catalog-match-types.ts, so a client component can render a
 * bin or an inventory row without pulling Prisma into the browser bundle.
 *
 * WHY THIS EXISTS AT ALL: the authoritative tables address each other by id.
 * A bin knows nothing about the part inside it without joining Inventory and
 * Part; a Movement stores partId and binId, not a SKU and a bin code. Doing
 * those joins in React would put warehouse logic in the browser and let two
 * implementations of "what is in B2-01" drift apart. So the server composes the
 * whole view once (dashboard-service.ts) and the UI only formats it.
 *
 * Every field here is derived from the database. Nothing in this contract may
 * be inferred from a gantry animation, from previous React state, or from
 * local scan history — the warehouse database is the only authority.
 */
import type { BinStatus, MovementStatus, MovementType } from "./types";

/** One stack of one part inside one bin. */
export interface BinContentView {
  partId: string;
  sku: string;
  canonicalName: string;
  quantity: number;
  /** Catalog reference image for identifying the stored object visually. */
  catalogImageUrl?: string | null;
  /**
   * The photo from the most recent COMPLETED putaway of this part into this
   * bin, if one was captured. Null for stock that predates the photo feature,
   * or if the upload failed at the time (never blocks the physical putaway).
   */
  imageUrl: string | null;
}

/** Most recent placement-verification or inventory-audit photo for one bin. */
export interface BinSnapshotView {
  imageUrl: string;
  capturedAt: number;
  source: "PUTAWAY" | "INVENTORY_AUDIT";
  recordId: string;
  status: string;
  confidencePercent?: number | null;
}

/**
 * A bin as the map draws it. `status` is the Bin row's own status, never
 * inferred from whether `contents` is empty: a RESERVED bin is empty AND
 * unavailable, and collapsing those two facts would let the UI offer a bin the
 * warehouse has already promised to something else.
 */
export interface BinView {
  binId: string;
  code: string;
  status: BinStatus;
  capacity: number;
  contents: BinContentView[];
  totalQuantity: number;
  /** Optional for compatibility with older cached overview responses. */
  latestSnapshot?: BinSnapshotView | null;
}

/** One part's stock, aggregated across every bin holding it. */
export interface InventoryRowView {
  partId: string;
  sku: string;
  canonicalName: string;
  category: string | null;
  totalQuantity: number;
  checkedOutQuantity?: number;
  locations: Array<{ binCode: string; binStatus?: BinStatus; quantity: number }>;
}

/**
 * One warehouse operation, resolved to human-facing names.
 *
 * `source`/`destination` flatten the bin-or-station split the Movement table
 * keeps (a putaway starts at the INTAKE station, not a bin), because an
 * operator reads "INTAKE → B2-01" as one route.
 */
export interface MovementRowView {
  id: string;
  type: MovementType;
  status: MovementStatus;
  sku: string;
  canonicalName: string;
  quantity: number;
  source: string | null;
  destination: string | null;
  /** Epoch ms, so the browser formats in the operator's own timezone. */
  createdAt: number;
  completedAt: number | null;
}

export interface BinAuditView {
  captureMode: "PROD" | "SIMULATION";
  binAuditId: string;
  binCode: string;
  sku: string | null;
  status: string;
  expectedQuantity: number;
  observedQuantity: number | null;
  confidencePercent: number | null;
  inventoryUpdated: boolean;
  previousQuantity: number | null;
  newQuantity: number | null;
  evidenceUrl: string | null;
  /** This bin's accepted evidence from before this audit — the "before" half of the comparison. Null if never photographed before. */
  priorEvidenceUrl: string | null;
  /** True for a REVIEW_REQUIRED audit a human can still act on: known part, countable observation. */
  awaitingConfirmation: boolean;
  /**
   * True only when the observation itself is trustworthy and just came in
   * lower than what's on file — the one case where applying it is actually
   * safe. A rejection for low confidence, a suspected foreign object, an
   * over-capacity count, or unregistered stock is never applicable: the
   * count can't be trusted at all, so "apply" would defeat the reason it
   * was flagged. Those cases can still be dismissed, just never applied.
   */
  canApply: boolean;
  reason: string | null;
}

/** Latest durable physical audit, including every per-bin database outcome. */
export interface InventoryAuditView {
  auditRunId: string;
  trigger: string;
  status: string;
  requestedBinCode: string | null;
  binsPlanned: number;
  binsCompleted: number;
  verifiedBins: number;
  reconciledBins: number;
  reviewRequiredBins: number;
  failedBins: number;
  startedAt: number;
  completedAt: number | null;
  bins: BinAuditView[];
}

/** One authoritative snapshot of warehouse state. */
export interface WarehouseOverview {
  /** Epoch ms the server composed this snapshot. */
  generatedAt: number;
  bins: BinView[];
  inventory: InventoryRowView[];
  movements: MovementRowView[];
  /** Optional so an older cached overview remains renderable after deployment. */
  latestAudit?: InventoryAuditView | null;
  totals: {
    /** Total units of stock held across every bin. */
    units: number;
    distinctParts: number;
    binsAvailable: number;
    binsOccupied: number;
  };
}
