/**
 * Direct high-level putaway adapter.
 *
 * It is a three-line adapter on purpose. Every decision that matters — is the
 * scan valid, does it match exactly one catalog part, is that bin still free,
 * is the gantry idle, may inventory increase — belongs to `executePutaway` in
 * the warehouse layer, which is callable and testable without an LLM anywhere
 * near it. Business logic in a tool callback would mean the agent's request
 * and the warehouse's correctness lived in the same place.
 *
 *   Strands tool -> PutawayService -> catalog matcher + database + GantryController
 *
 * WHY THERE IS NO `scanResult` PARAMETER. The suggested design took the scan
 * as a tool argument. That would let the model author the measurements the
 * deterministic matcher scores — inventing a scan that matches BRG-6204 would
 * be enough to move a real gantry and create real stock. For a read-only tool
 * that is merely useless; for a write tool it is an attack. So the scan comes
 * only from the request-scoped context the API validated (request-context.ts),
 * and a putaway with no attached scan is refused. The model still chooses the
 * destination bin, which the service revalidates anyway.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runPutawayGraph } from "@/lib/warehouse/graphs/putaway-graph";
import {
  getContextCatalogResolutionId,
  getContextScanImageDataUrl,
  getContextScanResult,
  recordContextWorkflow,
} from "../request-context";
import { logTool, toolFailure } from "./tool-logging";

export const EXECUTE_PUTAWAY_TOOL_NAME = "execute_putaway";

export const executePutawayInputSchema = z.object({
  destinationBinCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Optional bin code such as \"B2-01\". Omit it to return the matching checked-out bin, or otherwise choose the best compatible capacity-aware bin. Whatever is supplied is revalidated.",
    ),
});

export const executePutawayTool = tool({
  name: EXECUTE_PUTAWAY_TOOL_NAME,
  description:
    "Put away the camera-verified part or parts attached to this request. THIS TOOL CHANGES WAREHOUSE STATE AND RUNS THE GANTRY. It uses the automatic camera count and photo, returns a matching CHECKED_OUT bin by default and reconciles its preserved quantity, safely relocates it to an explicitly selected empty AVAILABLE slot, or chooses a compatible capacity-aware shelf bin for new intake. Use only for an explicit physical putaway request. ok:true means both movement and database commit completed.",
  inputSchema: executePutawayInputSchema,
  callback: async ({ destinationBinCode }) => {
    // The scan the API validated — never one the model wrote.
    const scanResult = getContextScanResult();
    if (!scanResult) {
      logTool(EXECUTE_PUTAWAY_TOOL_NAME, "-", "no_scan_result_available");
      return {
        ok: false as const,
        reason: "invalid_scan" as const,
        message:
          "No scan is attached to this request, so there is nothing to put away. Ask the operator to scan the item first.",
      };
    }

    try {
      // Milestone 11: the tool now asks the putaway GRAPH, which sequences the
      // deterministic stages and calls PutawayService from its single execute
      // node. The service is still the authority — it revalidates the scan,
      // the match, the bin and the gantry from scratch — and `run.result` is
      // the unchanged Milestone 7 contract, so nothing the agent sees changed.
      const run = await runPutawayGraph({
        scanResult,
        imageDataUrl: getContextScanImageDataUrl() ?? undefined,
        destinationBinCode,
        // Supplied by the operator through the API, never by the model — see
        // request-context.ts. The service revalidates it regardless.
        catalogResolutionId: getContextCatalogResolutionId() ?? undefined,
      });
      // Operator-facing workflow progress. Never returned to the model: the
      // model gets the service result, exactly as before.
      recordContextWorkflow(run.graph);
      const result = run.result;
      logTool(
        EXECUTE_PUTAWAY_TOOL_NAME,
        `scanId="${scanResult.scanId}" bin="${destinationBinCode ?? "auto"}"`,
        result.ok ? `COMPLETED -> ${result.destinationBinCode}` : result.reason,
      );
      return result;
    } catch (err) {
      return toolFailure(EXECUTE_PUTAWAY_TOOL_NAME, err);
    }
  },
});
