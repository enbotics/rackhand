/**
 * execute_retrieval — the agent's second and last state-changing capability.
 *
 * A thin adapter over the retrieval workflow. Every decision that matters — does the
 * part exist, is there stock, which bin, is the gantry free, may inventory
 * decrease — belongs to `executeRetrieval` in the warehouse layer, which is
 * callable and testable with no LLM anywhere near it.
 *
 *   Strands tool -> RetrievalService -> catalog + inventory + GantryController
 *
 * IDENTITY IS AUTHORITATIVE, NEVER FREE TEXT. The tool takes a SKU, a part
 * id, or a bin code — not "a 6204 bearing". A bin holds at most one SKU at a
 * time (the same invariant get_bin_status relies on), so naming ONLY a bin
 * is itself authoritative identity, resolved from what that bin actually
 * holds — never a guess. Interpreting an operator's phrasing is what the
 * read-only tools are for; by the time the gantry is asked to move, the part
 * (or the bin standing in for it) must already be pinned down. The service
 * revalidates it regardless.
 *
 * The machine checks out the entire source bin and verifies its camera/scale
 * evidence. Trusted counts reconcile automatically; unexpected objects require
 * correction and retry. A later return separately verifies the remainder.
 *
 * IDEMPOTENCY IS SERVER-OWNED. The HTTP request id is used, so one operator
 * message can cause at most one physical retrieval. It is deliberately absent
 * from the model-authored tool arguments.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runRetrievalGraph } from "@/lib/warehouse/graphs/retrieval-graph";
import { getContextRequestId, recordContextWorkflow, getContextBrowserScenario, getContextWorkflowSessionId } from "../request-context";
import { controlModuleCurrentPart } from "@/lib/warehouse/control-module-scenario";
import { logTool, toolFailure } from "./tool-logging";

export const EXECUTE_RETRIEVAL_TOOL_NAME = "execute_retrieval";

export const executeRetrievalInputSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact catalog SKU, e.g. \"BRG-6204\". Resolve it with search_catalog or search_inventory first. Omit if identifying by bin alone."),
    partId: z.string().trim().min(1).optional().describe("Internal catalog part id. Omit if identifying by bin alone."),
    sourceBinCode: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "A bin to take it from, e.g. \"B2-01\". With sku/partId, just narrows where to take it from. WITHOUT sku or partId, this alone IS the identity — the operator named a bin and nothing else, e.g. \"retrieve B2-01\": pass only sourceBinCode and the part is resolved from that bin's own contents (a bin holds at most one SKU). Omit entirely, with sku/partId given, to let the warehouse pick a bin deterministically.",
      ),
    remainingItems: z
      .array(z.string().trim().min(1))
      .optional()
      .describe(
        "Only when the CURRENT operator message named more than one item to fetch (e.g. \"I need screws and allen keys\"): the OTHER item descriptions, in the operator's own words, NOT including the one you are retrieving in this call. Omit entirely for a single-item request. The system fetches each remaining item automatically, one at a time, after this one and its putaway offer are resolved — you never need to call execute_retrieval again yourself for them.",
      ),
  })
  .refine(
    (value) => !(value.sku && value.partId) && Boolean(value.sku || value.partId || value.sourceBinCode),
    { message: "provide a sku, a partId, or a sourceBinCode" },
  );

export const executeRetrievalTool = tool({
  name: EXECUTE_RETRIEVAL_TOOL_NAME,
  description:
    "Check out one entire physical bin to OUTPUT, then verify it automatically with a fresh camera capture and scale reading. THIS TOOL CHANGES PHYSICAL WAREHOUSE STATE. Trusted counts automatically correct recorded stock in either direction. Unexpected objects or uncertain evidence require correction and retry in the popup; the bin stays at checkout. Identify by exact SKU/part id or sourceBinCode ALONE when only a bin was named. The bin is CHECKED_OUT and excluded from shelf-available stock; a later putaway separately verifies the actual remainder. Use only for explicit physical retrieval, never inventory questions. For several requested items, retrieve the first and pass the rest as remainingItems; never call this a second time yourself for them. The service revalidates identity, stock and occupancy.",
  inputSchema: executeRetrievalInputSchema,
  callback: async ({ sku, partId, sourceBinCode }) => {
    try {
      // Milestone 11: the tool asks the retrieval GRAPH, whose single execute
      // node calls RetrievalService. The service still revalidates identity,
      // stock, the source bin and the gantry, and `run.result` is the
      // unchanged Milestone 8 contract.
      const demoBin = getContextBrowserScenario() ? controlModuleCurrentPart(getContextWorkflowSessionId()) : null;
      if (getContextBrowserScenario() && !demoBin) {
        return { ok: false, reason: "invalid_request", message: "The browser demo is no longer active. Start the control module prep again." };
      }
      const run = await runRetrievalGraph({
        sku: demoBin?.sku ?? sku,
        partId: demoBin ? undefined : partId,
        sourceBinCode: demoBin?.binCode ?? sourceBinCode,
        // Server-authored only; prompt text cannot select an idempotency key.
        requestId: getContextRequestId() ?? undefined,
      });
      recordContextWorkflow(run.graph);
      const result = run.result;
      logTool(
        EXECUTE_RETRIEVAL_TOOL_NAME,
        `part="${sku ?? partId ?? "(from bin)"}" bin="${sourceBinCode ?? "auto"}"`,
        result.ok
          ? `CHECKED_OUT ${result.sourceBinCode} with ${result.checkedOutQuantity} last-verified unit(s)`
          : result.reason,
      );
      return result;
    } catch (err) {
      return toolFailure(EXECUTE_RETRIEVAL_TOOL_NAME, err);
    }
  },
});
