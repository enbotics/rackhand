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
    "Search the authoritative warehouse inventory for a part using its SKU or human-readable text, and return the total quantity in stock plus the bin codes holding it. Use this for questions about how many of something there are or where it is stored. A known part with no stock returns totalQuantity 0; a part that is not in the catalog at all returns found:false. Read-only; it never adds, removes or moves inventory.",
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
