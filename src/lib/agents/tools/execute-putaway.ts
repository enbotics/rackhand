/**
 * Direct high-level putaway adapter.
 *
 * It is a thin adapter on purpose. Every decision that matters — is the scan
 * valid, does it match exactly one catalog part, is that bin still free, is
 * the gantry idle, may inventory increase — belongs to the warehouse layer
 * (`executePutaway` / `returnCheckedOutBin`), which is callable and testable
 * without an LLM anywhere near it. Business logic in a tool callback would
 * mean the agent's request and the warehouse's correctness lived in the same
 * place.
 *
 *   Strands tool -> PutawayService -> catalog matcher + database + GantryController
 *
 * Both paths require one fresh manual verification after approval. The image
 * count is compared with recorded stock under deterministic confidence rules.
 *
 * WHY THERE IS NO `scanResult` PARAMETER. The suggested design took the scan
 * as a tool argument. That would let the model author the measurements the
 * deterministic matcher scores — inventing a scan that matches BRG-6204 would
 * be enough to move a real gantry and create real stock. For a read-only tool
 * that is merely useless; for a write tool it is an attack. So the scan comes
 * only from the request-scoped context the API validated (request-context.ts).
 * The model still chooses the destination bin, which the service revalidates
 * anyway.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runPutawayGraph } from "@/lib/warehouse/graphs/putaway-graph";
import { returnCheckedOutBin } from "@/lib/warehouse/putaway-service";
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
      "Optional bin code such as \"B2-01\". Only meaningful WITH an attached scan. Omit it to return the matching checked-out bin, or otherwise choose the best compatible capacity-aware bin. Whatever is supplied is revalidated.",
    ),
  binCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Which CHECKED_OUT bin to return, e.g. \"B2-01\". Use for a known checked-out return even if an earlier scan remains attached. A fresh manual photo compares the current visible count with recorded stock. Omit it if exactly one bin is checked out; required if more than one is.",
    ),
});

export const executePutawayTool = tool({
  name: EXECUTE_PUTAWAY_TOOL_NAME,
  description:
    "Call this tool immediately for an explicit putaway or CHECKED_OUT-bin return; never ask for a photo in chat. After client HITL it opens the comparison flow. Production uses one fresh Pi frame; Simulation uses the next controlled fixture through the same Gemini and decision gates. Strictly over 80% confidence is required: equal proceeds, higher auto-updates after movement, lower requires human confirmation, and foreign objects/low confidence/occlusion/capacity overflow require the appropriate next capture. The gantry runs only after acceptance. ok:true means movement and database commit completed.",
  inputSchema: executePutawayInputSchema,
  callback: async ({ destinationBinCode, binCode }) => {
    // The scan the API validated — never one the model wrote.
    const scanResult = getContextScanResult();

    if (binCode || !scanResult) {
      // The service requests a fresh manual snapshot; historical images cannot bypass it.
      try {
        const result = await returnCheckedOutBin({ binCode });
        logTool(
          EXECUTE_PUTAWAY_TOOL_NAME,
          `no-scan return bin="${binCode ?? "auto"}"`,
          result.ok ? `COMPLETED -> ${result.destinationBinCode}` : result.reason,
        );
        return result;
      } catch (err) {
        return toolFailure(EXECUTE_PUTAWAY_TOOL_NAME, err);
      }
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
