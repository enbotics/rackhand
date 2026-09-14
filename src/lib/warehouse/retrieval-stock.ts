import type { RetrievalFailure } from "./retrieval-types";
import type { PartInventorySummary } from "./types";

type StockIssue = Pick<RetrievalFailure, "reason" | "message" | "sourceBinCode">;

/** Shelf availability is different from stock already at checkout or in a workflow. */
export function retrievalStockIssue(summary: PartInventorySummary, sourceBinCode?: string): StockIssue | null {
  const requested = sourceBinCode?.trim().toUpperCase();
  const locations = summary.locations.filter((location) => location.quantity > 0
    && (!requested || location.binCode === requested));
  if (locations.some((location) => location.binStatus === "OCCUPIED")) return null;

  const checkedOut = locations.find((location) => location.binStatus === "CHECKED_OUT");
  if (checkedOut) {
    return {
      reason: "source_bin_checked_out",
      sourceBinCode: checkedOut.binCode,
      message: `Bin ${checkedOut.binCode} holding ${summary.part.sku} is already at checkout with ${checkedOut.quantity} recorded units. It does not need another retrieval. Return bin ${checkedOut.binCode} to its shelf before retrieving it again.`,
    };
  }
  if (locations.length > 0) {
    return {
      reason: "inventory_conflict",
      sourceBinCode: locations[0].binCode,
      message: `${summary.part.sku} has recorded stock in ${locations.map((location) => `${location.binCode} (${location.binStatus})`).join(", ")}, but these bins are unavailable for retrieval. Finish the active workflow or reconcile the bin state first.`,
    };
  }
  // An explicit empty/wrong-part bin is handled by the source validation.
  if (requested && summary.locations.some((location) => location.quantity > 0)) return null;
  return {
    reason: "out_of_stock",
    message: `${summary.part.sku} is in the catalog but no bin currently holds any stock of it.`,
  };
}
