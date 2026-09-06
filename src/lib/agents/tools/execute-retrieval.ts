/**
 * execute_retrieval — the agent's second and last state-changing capability.
 *
 * A thin adapter, like execute_putaway. Every decision that matters — does the
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
 * QUANTITY IS DECLARED, NOT ASSUMED. The model must say how many the operator
 * asked for, and the service refuses anything but 1. A live run showed the
 * prompt rule alone was unreliable — the same "bring me 3" request retrieved
 * one item on one attempt and refused on another — so the constraint is
 * enforced where it cannot be forgotten.
 *
 * IDEMPOTENCY DEFAULTS TO THE REQUEST. If the model supplies no requestId, the
 * id of the HTTP request is used, so one operator message can cause at most one
 * physical retrieval — a model that calls this twice in one turn fetches one
 * part, not two, without having to remember anything.
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
        "Optional bin to take it from, e.g. \"B03\". Omit it unless the operator named a bin; the warehouse otherwise picks deterministically.",
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .describe(
        "How many items the operator asked for. Retrieval moves one item per operation, so any value other than 1 is refused — report that refusal rather than retrieving one of several.",
      ),
    requestId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional. Omit it — the server supplies one so a retry cannot fetch a second part."),
  })
  .refine((value) => Boolean(value.sku) !== Boolean(value.partId), {
    message: "provide exactly one of sku or partId",
  });

export const executeRetrievalTool = tool({
  name: EXECUTE_RETRIEVAL_TOOL_NAME,
  description:
    "Retrieve exactly one existing spare part from warehouse inventory to the OUTPUT station. THIS TOOL CHANGES WAREHOUSE STATE AND RUNS A SIMULATED GANTRY OPERATION: it moves the part out of its bin and decreases inventory. Use it only when the operator has explicitly asked to bring, fetch or take out a physical part — never to answer where a part is, how many there are, or which bin holds it, which are search_inventory and get_bin_status. Identify the part by exact SKU or part id, resolved beforehand with the read-only tools; never guess one. It handles one item per call: pass the quantity the operator asked for, and a request for more than one is refused outright rather than partly fulfilled. It independently revalidates catalog identity, current stock, the source bin and gantry readiness, and decreases inventory only after the gantry completed.",
  inputSchema: executeRetrievalInputSchema,
  callback: async ({ sku, partId, sourceBinCode, quantity, requestId }) => {
    try {
      // Milestone 11: the tool asks the retrieval GRAPH, whose single execute
      // node calls RetrievalService. The service still revalidates identity,
      // stock, the source bin and the gantry, and `run.result` is the
      // unchanged Milestone 8 contract.
      const run = await runRetrievalGraph({
        sku,
        partId,
        sourceBinCode,
        quantity,
        // The HTTP request's id unless the model deliberately supplied one.
        requestId: requestId ?? getContextRequestId() ?? undefined,
      });
      recordContextWorkflow(run.graph);
      const result = run.result;
      logTool(
        EXECUTE_RETRIEVAL_TOOL_NAME,
        `part="${sku ?? partId}" bin="${sourceBinCode ?? "auto"}"`,
        result.ok
          ? `COMPLETED from ${result.sourceBinCode} (remaining ${result.remainingQuantityInBin})`
          : result.reason,
      );
      return result;
    } catch (err) {
      return toolFailure(EXECUTE_RETRIEVAL_TOOL_NAME, err);
    }
  },
});
