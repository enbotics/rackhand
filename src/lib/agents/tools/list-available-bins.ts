/**
 * list_available_bins — which bins could take stock.
 *
 * READ-ONLY, and the distinction matters: listing eligibility is not
 * allocation. Nothing here reserves a bin, marks one, or promises it will
 * still be free later. Reservation is a write path and belongs to a later
 * milestone.
 *
 *   Strands tool -> listAvailableBins() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { listAvailableBins } from "@/lib/warehouse/repository";
import { logTool, toolFailure } from "./tool-logging";

export const LIST_AVAILABLE_BINS_TOOL_NAME = "list_available_bins";

export const listAvailableBinsInputSchema = z.object({});

export const listAvailableBinsTool = tool({
  name: LIST_AVAILABLE_BINS_TOOL_NAME,
  description:
    "List the storage bins that are currently AVAILABLE, meaning they hold no stock and are not reserved or disabled. Use this for questions about free or empty storage space. This only reports which bins are eligible for a future putaway; it is read-only and does not reserve, allocate or claim any bin.",
  inputSchema: listAvailableBinsInputSchema,
  callback: async () => {
    try {
      const bins = await listAvailableBins();
      logTool(LIST_AVAILABLE_BINS_TOOL_NAME, "-", `${bins.length} available`);

      return {
        count: bins.length,
        bins: bins.map((bin) => ({
          code: bin.code,
          status: bin.status,
          capacity: bin.capacity,
        })),
      };
    } catch (err) {
      return toolFailure(LIST_AVAILABLE_BINS_TOOL_NAME, err);
    }
  },
});
