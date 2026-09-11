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
 * The machine checks out the entire source bin. Its last verified quantity is
 * preserved until the bin returns through photographed putaway, when the
 * deterministic service reconciles the observed remainder.
 *
 * IDEMPOTENCY IS SERVER-OWNED. The HTTP request id is used, so one operator
 * message can cause at most one physical retrieval. It is deliberately absent
 * from the model-authored tool arguments.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runRetrievalGraph } from "@/lib/warehouse/graphs/retrieval-graph";
import { getContextRequestId, recordContextWorkflow } from "../request-context";
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
  })
  .refine(
    (value) => !(value.sku && value.partId) && Boolean(value.sku || value.partId || value.sourceBinCode),
    { message: "provide a sku, a partId, or a sourceBinCode" },
  );

export const executeRetrievalTool = tool({
  name: EXECUTE_RETRIEVAL_TOOL_NAME,
  description:
    "Check out one entire physical bin and move it to OUTPUT. THIS TOOL CHANGES PHYSICAL WAREHOUSE STATE. Identify what to retrieve either by an exact SKU/part id (optionally narrowed to one bin), or by sourceBinCode ALONE when the operator only named a bin — a bin holds at most one SKU, so the bin code is itself authoritative identity, resolved server-side from that bin's contents, never guessed. It preserves the bin's last verified quantity for later photographed return reconciliation and marks the bin CHECKED_OUT, so those units are not reported as shelf-available. Use only for an explicit physical retrieval request, never for an inventory question. The service independently revalidates identity, stock and source-bin occupancy.",
  inputSchema: executeRetrievalInputSchema,
  callback: async ({ sku, partId, sourceBinCode }) => {
    try {
      // Milestone 11: the tool asks the retrieval GRAPH, whose single execute
      // node calls RetrievalService. The service still revalidates identity,
      // stock, the source bin and the gantry, and `run.result` is the
      // unchanged Milestone 8 contract.
      const run = await runRetrievalGraph({
        sku,
        partId,
        sourceBinCode,
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
