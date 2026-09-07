/** Read the durable Supabase-backed status of the attached scan's putaway. */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { getGuidedPutawayStatusForScan } from "@/lib/warehouse/guided-putaway-service";
import { getContextScanResult } from "../request-context";
import { logTool, toolFailure } from "./tool-logging";

export const GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME = "get_guided_putaway_status";

export const getGuidedPutawayStatusTool = tool({
  name: GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
  description:
    "Read the durable guided-putaway status for the scan attached to this request, including separate gantry and Supabase database states. READ-ONLY: it never reserves a slot, moves the gantry, confirms placement, or changes inventory. Use it when the operator asks whether the current scanned item is waiting, moving, saved, cancelled, failed, or needs reconciliation.",
  inputSchema: z.object({}),
  callback: async () => {
    const scan = getContextScanResult();
    if (!scan) {
      return {
        ok: false as const,
        reason: "no_scan_result_available" as const,
        message: "No scan is attached, so there is no current putaway to inspect.",
      };
    }
    try {
      const workflow = await getGuidedPutawayStatusForScan(scan.scanId);
      logTool(
        GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
        `scanId="${scan.scanId}"`,
        workflow?.movementStatus ?? "not_started",
      );
      return workflow
        ? { ok: true as const, found: true as const, workflow }
        : {
            ok: true as const,
            found: false as const,
            scanId: scan.scanId,
            message: "No guided putaway has reserved a slot for this scan yet.",
          };
    } catch (error) {
      return toolFailure(GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME, error);
    }
  },
});
