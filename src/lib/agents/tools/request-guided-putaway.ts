/**
 * request_guided_putaway — hand an explicit storage request to the operator UI.
 *
 * READ-ONLY. This tool revalidates the server-attached scan, resolves only an
 * identity the deterministic matcher (or a recorded human decision) permits,
 * and reports the currently available slots. It does not reserve a bin, move
 * the gantry, or write inventory. The browser treats the tool call as a signal
 * to open the guided putaway dialog; that deterministic workflow owns every
 * later state change.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { resolveCatalogIdentity } from "@/lib/warehouse/catalog-identity";
import { getPartById, listAvailableBins } from "@/lib/warehouse/repository";
import {
  getContextCatalogResolutionId,
  getContextScanResult,
} from "../request-context";
import { logTool, toolFailure } from "./tool-logging";

export const REQUEST_GUIDED_PUTAWAY_TOOL_NAME = "request_guided_putaway";

export const requestGuidedPutawayInputSchema = z.object({});

export const requestGuidedPutawayTool = tool({
  name: REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
  description:
    "Open and prepare the operator-guided putaway experience for the scan attached to this request. READ-ONLY: it checks catalog identity and lists currently available slots, but it never reserves a bin, moves the gantry, or changes inventory. Use it only when the operator explicitly asks to store or put away the scanned item. The operator will choose the slot and confirm physical placement in the guided dialog.",
  inputSchema: requestGuidedPutawayInputSchema,
  callback: async () => {
    const scanResult = getContextScanResult();
    if (!scanResult) {
      logTool(REQUEST_GUIDED_PUTAWAY_TOOL_NAME, "-", "no_scan_result_available");
      return {
        ok: false as const,
        status: "BLOCKED" as const,
        reason: "invalid_scan" as const,
        message: "No scan is attached. Ask the operator to scan the item first.",
      };
    }

    try {
      const match = await matchScanToCatalog(scanResult);
      const resolved = await resolveCatalogIdentity({
        scanId: scanResult.scanId,
        match,
        catalogResolutionId: getContextCatalogResolutionId(),
      });
      if (!resolved.ok) {
        logTool(REQUEST_GUIDED_PUTAWAY_TOOL_NAME, `scanId="${scanResult.scanId}"`, resolved.reason);
        return {
          ok: false as const,
          status: "BLOCKED" as const,
          reason: resolved.reason,
          message: resolved.message,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
      }

      const [part, bins] = await Promise.all([
        getPartById(resolved.identity.partId),
        listAvailableBins(),
      ]);
      if (!part) {
        return {
          ok: false as const,
          status: "BLOCKED" as const,
          reason: "part_not_found" as const,
          message: "The identified part is no longer present in the catalog.",
        };
      }
      if (bins.length === 0) {
        logTool(
          REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
          `scanId="${scanResult.scanId}"`,
          "no_available_bin",
        );
        return {
          ok: false as const,
          status: "BLOCKED" as const,
          reason: "no_available_bin" as const,
          part: {
            partId: part.id,
            sku: part.sku,
            canonicalName: part.canonicalName,
          },
          message: "No storage slot is currently AVAILABLE for guided putaway.",
        };
      }

      logTool(
        REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
        `scanId="${scanResult.scanId}"`,
        `AWAITING_SLOT available=${bins.length}`,
      );
      return {
        ok: true as const,
        status: "AWAITING_SLOT" as const,
        scanId: scanResult.scanId,
        part: {
          partId: part.id,
          sku: part.sku,
          canonicalName: part.canonicalName,
        },
        availableBins: bins.map((bin) => ({
          code: bin.code,
          capacity: bin.capacity,
        })),
        message:
          "The guided putaway dialog is ready. The operator must choose an available slot before the gantry moves.",
      };
    } catch (error) {
      return toolFailure(REQUEST_GUIDED_PUTAWAY_TOOL_NAME, error);
    }
  },
});
