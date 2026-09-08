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
 * IDENTITY IS AUTHORITATIVE, NEVER FREE TEXT. The tool takes a SKU or a part
 * id, not "a 6204 bearing". Interpreting an operator's phrasing is what the
 * read-only tools are for; by the time the gantry is asked to move, the part
 * must already be pinned down. The service revalidates it regardless.
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
      .describe("Exact catalog SKU, e.g. \"BRG-6204\". Resolve it with search_catalog or search_inventory first."),
    partId: z.string().trim().min(1).optional().describe("Internal catalog part id."),
    sourceBinCode: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Optional bin to take it from, e.g. \"B2-01\". Omit it unless the operator named a bin; the warehouse otherwise picks deterministically.",
      ),
  })
  .refine((value) => Boolean(value.sku) !== Boolean(value.partId), {
    message: "provide exactly one of sku or partId",
  });

export const executeRetrievalTool = tool({
  name: EXECUTE_RETRIEVAL_TOOL_NAME,
  description:
    "Check out the entire physical bin holding an exact catalog part and move that bin to OUTPUT. THIS TOOL CHANGES PHYSICAL WAREHOUSE STATE. It preserves the bin's last verified quantity for later photographed return reconciliation and marks the bin CHECKED_OUT, so those units are not reported as shelf-available. Use only for an explicit physical retrieval request, never for an inventory question. Resolve an exact SKU or part id first; the service independently revalidates stock, source-bin occupancy and gantry readiness.",
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
        `part="${sku ?? partId}" bin="${sourceBinCode ?? "auto"}"`,
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
