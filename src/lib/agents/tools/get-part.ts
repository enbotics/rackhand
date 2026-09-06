/**
 * get_part — one authoritative catalog part, by SKU or internal id.
 *
 * READ-ONLY. Delegates to the repository's existing lookups. A miss is a
 * structured `{ found: false, reason: "part_not_found" }` rather than a thrown
 * error, so the model can say "we do not stock that" instead of surfacing an
 * opaque failure.
 *
 *   Strands tool -> getPartBySku() / getPartById() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { getPartById, getPartBySku } from "@/lib/warehouse/repository";
import { logTool, toolFailure } from "./tool-logging";
import { toPartView } from "./views";

export const GET_PART_TOOL_NAME = "get_part";

/**
 * Exactly one identifier. Accepting both would need a precedence rule the
 * model could not see, and a request naming two different parts is a mistake
 * worth reporting rather than silently resolving.
 */
export const getPartInputSchema = z
  .object({
    sku: z.string().trim().min(1).optional().describe("Exact catalog SKU, e.g. \"BRG-6204\"."),
    partId: z.string().trim().min(1).optional().describe("Internal catalog part id."),
  })
  .refine((value) => Boolean(value.sku) !== Boolean(value.partId), {
    message: "provide exactly one of sku or partId",
  });

export const getPartTool = tool({
  name: GET_PART_TOOL_NAME,
  description:
    "Look up one catalog part by its exact SKU or internal part id and return its canonical name, category, description and nominal dimensions. Use this when the SKU is already known; use search_catalog when it is not. Returns found:false if no such part exists. Read-only; it never creates or changes a catalog part.",
  inputSchema: getPartInputSchema,
  callback: async ({ sku, partId }) => {
    try {
      const part = sku ? await getPartBySku(sku) : await getPartById(partId as string);
      const identifier = sku ? `sku="${sku}"` : `partId="${partId}"`;

      if (!part) {
        logTool(GET_PART_TOOL_NAME, identifier, "part_not_found");
        return {
          found: false as const,
          reason: "part_not_found" as const,
          ...(sku ? { sku } : { partId }),
        };
      }

      logTool(GET_PART_TOOL_NAME, identifier, `found ${part.sku}`);
      return { found: true as const, part: toPartView(part) };
    } catch (err) {
      return toolFailure(GET_PART_TOOL_NAME, err);
    }
  },
});
