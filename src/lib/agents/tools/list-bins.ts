/**
 * list_bins — the whole-shelf survey tool.
 *
 * READ-ONLY. Exists so a question about the shelf as a whole ("which bins
 * are occupied", "how full are we", "where does this SKU sit") is answered
 * from one exhaustive query instead of the model guessing bin codes and
 * calling get_bin_status on each guess — a sample that can silently miss
 * bins and turn into a false universal claim ("only B1-01 is occupied").
 * countsByStatus and totalBins are computed from the SAME unfiltered set the
 * bin list is capped from, so a truncated bins array never invalidates the
 * counts — the agent can always state an exhaustive fact even when it can't
 * enumerate every row.
 *
 *   Strands tool -> listBins() + listInventory() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { listBins } from "@/lib/warehouse/repository";
import { listInventory } from "@/lib/warehouse/inventory-service";
import { BIN_STATUSES } from "@/lib/warehouse/types";
import { logTool, toolFailure } from "./tool-logging";

export const LIST_BINS_TOOL_NAME = "list_bins";

/** Keeps a huge warehouse from flooding the model's context in one call. */
const MAX_BINS_RETURNED = 200;

export const listBinsInputSchema = z.object({
  status: z
    .array(z.enum(BIN_STATUSES))
    .optional()
    .describe("Restrict to these bin statuses, e.g. [\"OCCUPIED\"]. Omit for every status."),
  sku: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Restrict to bins currently holding this exact SKU."),
});

export const listBinsTool = tool({
  name: LIST_BINS_TOOL_NAME,
  description:
    "Survey the whole shelf in one call: every bin's code, status and contents, optionally filtered by status (e.g. OCCUPIED, AVAILABLE, CHECKED_OUT) or by an exact SKU. Returns totalBins and countsByStatus computed over the FULL set, plus a bins list (capped) — so a count or \"which bins are X\" claim can always be stated as exhaustive. Use this for any question about several bins or the shelf as a whole; for one named bin, use get_bin_status instead. Read-only.",
  inputSchema: listBinsInputSchema,
  callback: async ({ status, sku }) => {
    try {
      const [bins, inventory] = await Promise.all([listBins(), listInventory()]);

      // One SKU per bin is a service-layer rule (see get_bin_status), so at
      // most one row per bin code. A zero-quantity row is bookkeeping left
      // by a retrieval, not stock — it must not make an empty bin look held.
      const contentsByBinCode = new Map<string, { sku: string; quantity: number }>();
      for (const row of inventory) {
        if (row.quantity > 0) contentsByBinCode.set(row.binCode, { sku: row.sku, quantity: row.quantity });
      }

      const countsByStatus: Record<string, number> = {};
      for (const bin of bins) {
        countsByStatus[bin.status] = (countsByStatus[bin.status] ?? 0) + 1;
      }

      const normalizedSku = sku?.toUpperCase();
      const matched = bins.filter((bin) => {
        if (status && status.length > 0 && !status.includes(bin.status as (typeof BIN_STATUSES)[number])) {
          return false;
        }
        if (normalizedSku) {
          const contents = contentsByBinCode.get(bin.code);
          if (!contents || contents.sku.toUpperCase() !== normalizedSku) return false;
        }
        return true;
      });

      logTool(
        LIST_BINS_TOOL_NAME,
        `status=${status?.join(",") ?? "any"} sku=${sku ?? "-"}`,
        `${matched.length}/${bins.length} matched`,
      );

      return {
        totalBins: bins.length,
        matchedCount: matched.length,
        countsByStatus,
        truncated: matched.length > MAX_BINS_RETURNED,
        bins: matched.slice(0, MAX_BINS_RETURNED).map((bin) => {
          const contents = contentsByBinCode.get(bin.code) ?? null;
          return {
            code: bin.code,
            status: bin.status,
            capacity: bin.capacity,
            sku: contents?.sku ?? null,
            quantity: contents?.quantity ?? null,
          };
        }),
      };
    } catch (err) {
      return toolFailure(LIST_BINS_TOOL_NAME, err);
    }
  },
});
