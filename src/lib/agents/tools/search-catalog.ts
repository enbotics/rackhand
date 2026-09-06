/**
 * search_catalog — find catalog parts from human-readable text.
 *
 * READ-ONLY. Delegates ranking to `searchParts` in the warehouse layer; this
 * file only adapts input and shapes output. It never creates a Part, and it
 * never asks the model to guess catalog contents: an empty result is an
 * honest empty result.
 *
 *   Strands tool -> searchParts() -> listParts() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  MAX_CATALOG_SEARCH_LIMIT,
  searchParts,
} from "@/lib/warehouse/catalog-search";
import { logTool, toolFailure } from "./tool-logging";
import { toPartView } from "./views";

export const SEARCH_CATALOG_TOOL_NAME = "search_catalog";

export const searchCatalogInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("SKU, part name, category, or identifying text, e.g. \"6204 bearing\" or \"BRG-6204\"."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CATALOG_SEARCH_LIMIT)
    .optional()
    .describe("Maximum parts to return. Defaults to 5."),
});

export const searchCatalogTool = tool({
  name: SEARCH_CATALOG_TOOL_NAME,
  description:
    "Search the authoritative part catalog by SKU, part name, category or free text, and return the catalog entries that match with their canonical name and nominal dimensions. Use this to find out whether a part exists in the catalog and what its SKU is. It reports catalog identity only, not how many are in stock. Read-only; it never creates or changes a catalog part.",
  inputSchema: searchCatalogInputSchema,
  callback: async ({ query, limit }) => {
    try {
      const hits = await searchParts(query, limit);
      logTool(SEARCH_CATALOG_TOOL_NAME, `query="${query}"`, `${hits.length} match(es)`);

      return {
        query,
        resultCount: hits.length,
        results: hits.map((hit) => ({
          ...toPartView(hit.part),
          matchReason: hit.reason,
        })),
      };
    } catch (err) {
      return toolFailure(SEARCH_CATALOG_TOOL_NAME, err);
    }
  },
});
