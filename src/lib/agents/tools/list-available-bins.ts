/**
 * list_available_bins — which bins could take stock.
 *
 * READ-ONLY, and the distinction matters: listing eligibility is not
 * allocation. Nothing here reserves a bin, marks one, or promises it will
 * still be free later. Reservation is a write path and belongs to a later
 * milestone.
 *
 *   Strands tool -> listAvailableBins() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  getBinByCode,
  getPartById,
  getPartBySku,
  listAvailableBins,
  listPutawayDestinations,
} from "@/lib/warehouse/repository";
import { getInventoryForPart } from "@/lib/warehouse/inventory-service";
import { logTool, toolFailure } from "./tool-logging";

export const LIST_AVAILABLE_BINS_TOOL_NAME = "list_available_bins";

export const listAvailableBinsInputSchema = z
  .object({
    sku: z.string().trim().min(1).optional(),
    partId: z.string().trim().min(1).optional(),
    quantity: z.number().int().positive().optional(),
  })
  .refine((value) => !(value.sku && value.partId), {
    message: "provide sku or partId, not both",
  });

export const listAvailableBinsTool = tool({
  name: LIST_AVAILABLE_BINS_TOOL_NAME,
  description:
    "List putaway destinations without reserving them. With an exact sku or partId, reports a matching CHECKED_OUT home bin as the recommended return. While a bin is checked out, alternate returns list only empty AVAILABLE slots; otherwise compatible OCCUPIED same-part and AVAILABLE empty bins are listed with before/after/remaining capacity. Without a part identifier, lists empty AVAILABLE bins. Read-only.",
  inputSchema: listAvailableBinsInputSchema,
  callback: async ({ sku, partId, quantity }) => {
    try {
      const requestedQuantity = quantity ?? 1;
      if (sku || partId) {
        const part = sku ? await getPartBySku(sku) : await getPartById(partId ?? "");
        if (!part) {
          return { found: false as const, reason: "part_not_found" as const, bins: [] };
        }
        const destinations = (await listPutawayDestinations(part.id, requestedQuantity)).filter(
          (candidate) => candidate.eligible,
        );
        const inventory = await getInventoryForPart(part.sku);
        const checkedOutLocation = inventory.locations.find(
          (location) => location.binStatus === "CHECKED_OUT",
        );
        const checkedOutBin = checkedOutLocation
          ? await getBinByCode(checkedOutLocation.binCode)
          : null;
        const compatibleDestinations = checkedOutLocation
          ? destinations.filter(
              (candidate) =>
                candidate.status === "AVAILABLE" && candidate.currentQuantity === 0,
            )
          : destinations;
        logTool(
          LIST_AVAILABLE_BINS_TOOL_NAME,
          `sku="${part.sku}" quantity=${requestedQuantity}`,
          `${compatibleDestinations.length} compatible`,
        );
        return {
          found: true as const,
          part: { partId: part.id, sku: part.sku, canonicalName: part.canonicalName },
          quantity: requestedQuantity,
          recommendedReturn:
            checkedOutLocation && checkedOutBin
              ? {
                  code: checkedOutBin.code,
                  status: "CHECKED_OUT" as const,
                  meaning: "This is the part's physical home bin currently at OUTPUT.",
                  previousQuantity: checkedOutLocation.quantity,
                  observedReturnQuantity: requestedQuantity,
                  capacity: checkedOutBin.capacity,
                  remainingAfter: Math.max(0, checkedOutBin.capacity - requestedQuantity),
                  fits: requestedQuantity <= checkedOutBin.capacity,
                }
              : null,
          count: compatibleDestinations.length,
          bins: compatibleDestinations.map((bin) => ({
            code: bin.code,
            status: bin.status,
            capacity: bin.capacity,
            currentQuantity: bin.currentQuantity,
            afterQuantity: bin.afterQuantity,
            remainingAfter: bin.remainingAfter,
            alreadyStoresPart: bin.alreadyStoresPart,
          })),
        };
      }

      const bins = await listAvailableBins();
      logTool(LIST_AVAILABLE_BINS_TOOL_NAME, "-", `${bins.length} available`);

      return {
        count: bins.length,
        bins: bins.map((bin) => ({
          code: bin.code,
          status: bin.status,
          capacity: bin.capacity,
        })),
      };
    } catch (err) {
      return toolFailure(LIST_AVAILABLE_BINS_TOOL_NAME, err);
    }
  },
});
