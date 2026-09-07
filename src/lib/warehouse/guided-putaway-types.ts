import type { EffectiveCatalogIdentity } from "./catalog-resolution-types";
import type { ScanResult } from "./scan-types";

export interface GuidedPutawayRequest {
  scanResult: ScanResult;
  destinationBinCode: string;
  catalogResolutionId?: string;
  /**
   * The captured shot, as a data URL — optional, and never blocks the
   * putaway if upload fails. Uploaded to Supabase Storage once, at
   * reservation time, and the resulting URL is attached to the Movement for
   * the bin-detail modal to show later.
   */
  imageDataUrl?: string;
}

/** The human decision at the presented bin. Placement requires fresh photo evidence. */
export type GuidedPlacementDecision =
  | { placed: false }
  | {
      placed: true;
      verificationImageDataUrl: string;
      verificationCapturedAt: number;
    };

export type GuidedDatabaseStatus =
  | "CHECKING"
  | "RESERVED"
  | "WAITING_TO_SAVE"
  | "SAVING"
  | "SAVED"
  | "RELEASED"
  | "RECONCILIATION_REQUIRED";

export type GuidedGantryStatus =
  | "IDLE"
  | "FETCHING_BIN"
  | "WAITING_FOR_PLACEMENT"
  | "RETURNING_BIN"
  | "COMPLETED"
  | "FAILED";

export interface GuidedPutawayContext {
  movementId: string;
  scanId: string;
  part: { partId: string; sku: string; canonicalName: string };
  destinationBinCode: string;
}

/** Read-only, durable view used by the agent when an operator asks for progress. */
export interface GuidedPutawayStatusView extends GuidedPutawayContext {
  movementStatus: string;
  databaseStatus: GuidedDatabaseStatus;
  gantryStatus: GuidedGantryStatus;
  gantryOperationId: string | null;
  completedAt: number | null;
}

export type GuidedPutawayResult =
  | ({
      ok: true;
      stage:
        | "RESERVED"
        | "AWAITING_PLACEMENT"
        | "BIN_RETURNED"
        | "COMPLETED"
        | "CANCELLED";
      databaseStatus: GuidedDatabaseStatus;
      gantryStatus: GuidedGantryStatus;
      identity?: EffectiveCatalogIdentity;
      gantryOperationId?: string;
      inventoryQuantityAdded?: 0 | 1;
    } & GuidedPutawayContext)
  | {
      ok: false;
      reason: string;
      message: string;
      movementId?: string;
      scanId?: string;
      part?: GuidedPutawayContext["part"];
      destinationBinCode?: string;
      databaseStatus: GuidedDatabaseStatus;
      gantryStatus: GuidedGantryStatus;
      gantryOperationId?: string;
    };
