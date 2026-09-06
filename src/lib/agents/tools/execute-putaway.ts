/**
 * execute_putaway — the agent's ONLY state-changing capability.
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
      "Optional bin code such as \"B03\". Omit it to let the warehouse choose the first available bin. Whatever is supplied is revalidated before anything moves.",
    ),
});

export const executePutawayTool = tool({
  name: EXECUTE_PUTAWAY_TOOL_NAME,
  description:
    "Put away the one scanned physical part currently at the INTAKE station. THIS TOOL CHANGES WAREHOUSE STATE AND RUNS A SIMULATED GANTRY OPERATION: it reserves a bin, moves the part, and increases inventory. Use it only when the operator has explicitly asked to store or put away the scanned part — never to answer an informational question such as where a part could go, which is what search_inventory, get_bin_status and list_available_bins are for. It independently revalidates the scan, the catalog match and the bin before acting, and refuses unless the deterministic matcher returns MATCHED. It returns ok:true only when the gantry completed and inventory was updated.",
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
