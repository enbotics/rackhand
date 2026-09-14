/**
 * request_guided_putaway — hand an explicit storage request to the operator UI.
 *
 * READ-ONLY. This tool revalidates the server-attached scan, resolves only an
 * identity the deterministic matcher (or a recorded human decision) permits,
 * and reports capacity-compatible destinations. It does not reserve a bin, move
 * the gantry, or write inventory. The browser treats the tool call as a signal
 * to open the guided putaway dialog; that deterministic workflow owns every
 * later state change.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { resolveCatalogIdentity } from "@/lib/warehouse/catalog-identity";
import { getPartById, listPutawayDestinations } from "@/lib/warehouse/repository";
import { getAuditCaptureMode, isOutOfSimulationScope } from "@/lib/warehouse/audit-capture-mode";
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
    "Open and prepare the operator-guided putaway experience for the scan attached to this request. READ-ONLY: it checks catalog identity and evaluates bin compatibility and remaining capacity, but it never reserves a bin, moves the gantry, or changes inventory. An existing bin holding the same item is recommended when it has room; the operator may choose another compatible bin and must confirm physical placement in the guided dialog.",
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

      const part = await getPartById(resolved.identity.partId);
      if (!part) {
        return {
          ok: false as const,
          status: "BLOCKED" as const,
          reason: "part_not_found" as const,
          message: "The identified part is no longer present in the catalog.",
        };
      }
      const destinations = await listPutawayDestinations(part.id);
      const compatible = destinations.filter((bin) => bin.eligible && !isOutOfSimulationScope(bin.code));
      const recommended =
        compatible.find((bin) => bin.alreadyStoresPart) ?? compatible[0] ?? null;
      const fullExisting = destinations.find(
        (bin) => bin.alreadyStoresPart && bin.reason === "FULL",
      );
      if (compatible.length === 0) {
        logTool(
          REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
          `scanId="${scanResult.scanId}"`,
          "no_compatible_bin",
        );
        return {
          ok: false as const,
          status: "BLOCKED" as const,
          reason: "no_compatible_bin" as const,
          part: {
            partId: part.id,
            sku: part.sku,
            canonicalName: part.canonicalName,
          },
          message:
            getAuditCaptureMode() === "SIMULATION"
              ? "No compatible simulation bin can accept this item. Only B1-01 and B1-02 may move in this demo."
              : "No compatible available bin can accept this item. Check bin state and capacity.",
        };
      }

      logTool(
        REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
        `scanId="${scanResult.scanId}"`,
        `AWAITING_SLOT compatible=${compatible.length} recommended=${recommended?.code ?? "none"}`,
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
        compatibleBins: compatible.map((bin) => ({
          code: bin.code,
          status: bin.status,
          capacity: bin.capacity,
          currentQuantity: bin.currentQuantity,
          afterQuantity: bin.afterQuantity,
          remainingAfter: bin.remainingAfter,
          alreadyStoresPart: bin.alreadyStoresPart,
          recommended: bin.code === recommended?.code,
        })),
        message: recommended?.alreadyStoresPart
          ? `${recommended.code} is suggested because it already stores this item and has capacity (${recommended.currentQuantity} + 1 = ${recommended.afterQuantity}/${recommended.capacity}). The operator may choose another compatible bin before the gantry moves.`
          : fullExisting
            ? `${fullExisting.code} already stores this item but is full (${fullExisting.currentQuantity}/${fullExisting.capacity}); ${recommended?.code} is the suggested compatible empty bin. The operator may choose another compatible bin before the gantry moves.`
            : `${recommended?.code} is the suggested compatible empty bin (${recommended?.currentQuantity} + 1 = ${recommended?.afterQuantity}/${recommended?.capacity}). The operator may choose another compatible bin before the gantry moves.`,
      };
    } catch (error) {
      return toolFailure(REQUEST_GUIDED_PUTAWAY_TOOL_NAME, error);
    }
  },
});
