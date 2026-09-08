/**
 * search_inventory — how much of a part the warehouse holds, and where.
 *
 * READ-ONLY, and the tool most likely to be answered wrongly by guessing, so
 * it draws three distinctions the model must not blur:
 *
 *   unknown catalog part   -> found:false, reason:"part_not_found"
 *   known part, no stock   -> found:true,  totalQuantity:0, locations:[]
 *   query matches several  -> found:false, reason:"ambiguous_part_query"
 *
 * "We have none" and "no such part" are different answers to an operator, and
 * only the authoritative catalog can tell them apart.
 *
 *   Strands tool -> resolvePartQuery() -> getInventoryForPart() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { resolvePartQuery } from "@/lib/warehouse/catalog-search";
import { getInventoryForPart } from "@/lib/warehouse/inventory-service";
import { logTool, toolFailure } from "./tool-logging";
import { toPartRef } from "./views";

export const SEARCH_INVENTORY_TOOL_NAME = "search_inventory";

export const searchInventoryInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("SKU or human-readable part text, e.g. \"BRG-6204\" or \"6204 bearing\"."),
});

export const searchInventoryTool = tool({
  name: SEARCH_INVENTORY_TOOL_NAME,
  description:
    "Search the authoritative warehouse inventory for a part using its SKU or human-readable text. Returns shelf-available quantity separately from the last verified quantity travelling in CHECKED_OUT bins, plus every bin location. Use this for questions about how many are available or where a part is stored. A known part with no shelf stock returns totalQuantity 0; a part absent from the catalog returns found:false. Read-only; it never changes inventory.",
  inputSchema: searchInventoryInputSchema,
  callback: async ({ query }) => {
    try {
      const resolution = await resolvePartQuery(query);

      if (resolution.status === "not_found") {
        logTool(SEARCH_INVENTORY_TOOL_NAME, `query="${query}"`, "part_not_found");
        return { found: false as const, reason: "part_not_found" as const, query };
      }

      if (resolution.status === "ambiguous") {
        const candidates = resolution.candidates.map((hit) => toPartRef(hit.part));
        logTool(
          SEARCH_INVENTORY_TOOL_NAME,
          `query="${query}"`,
          `ambiguous (${candidates.length} candidates)`,
        );
        return {
          found: false as const,
          reason: "ambiguous_part_query" as const,
          query,
          candidates,
        };
      }

      const summary = await getInventoryForPart(resolution.part.sku);
      logTool(
        SEARCH_INVENTORY_TOOL_NAME,
        `query="${query}"`,
        `${summary.part.sku} qty=${summary.totalQuantity} bins=${summary.locations.length}`,
      );

      return {
        found: true as const,
        part: toPartRef(resolution.part),
        totalQuantity: summary.totalQuantity,
        checkedOutQuantity: summary.checkedOutQuantity,
        recordedQuantity: summary.recordedQuantity,
        locations: summary.locations.map((location) => ({
          binCode: location.binCode,
          binStatus: location.binStatus,
          quantity: location.quantity,
        })),
      };
    } catch (err) {
      return toolFailure(SEARCH_INVENTORY_TOOL_NAME, err);
    }
  },
});
