/**
 * get_bin_status — what one storage bin is and what is in it.
 *
 * READ-ONLY. Bin state comes from the authoritative warehouse database, never
 * from gantry simulator history: where the gantry last travelled is not
 * evidence about stock.
 *
 *   Strands tool -> getBinByCode() + getInventoryByBin() -> database
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { getBinByCode, getPartBySku } from "@/lib/warehouse/repository";
import { getInventoryByBin } from "@/lib/warehouse/inventory-service";
import { logTool, toolFailure } from "./tool-logging";

export const GET_BIN_STATUS_TOOL_NAME = "get_bin_status";

export const getBinStatusInputSchema = z.object({
  binCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .describe("Bin code, e.g. \"A01\" or \"B03\"."),
});

export const getBinStatusTool = tool({
  name: GET_BIN_STATUS_TOOL_NAME,
  description:
    "Return the authoritative state of one storage bin by its code: whether it is AVAILABLE, RESERVED, OCCUPIED or DISABLED, its capacity, and which part and quantity it currently holds. Use this for questions about a specific bin. Returns found:false if no bin has that code. Read-only; it never reserves a bin or changes its contents.",
  inputSchema: getBinStatusInputSchema,
  callback: async ({ binCode }) => {
    try {
      const bin = await getBinByCode(binCode);
      if (!bin) {
        logTool(GET_BIN_STATUS_TOOL_NAME, `binCode="${binCode}"`, "bin_not_found");
        return { found: false as const, reason: "bin_not_found" as const, binCode };
      }

      // One SKU per bin is a service-layer rule, so there is at most one row.
      const [stock] = await getInventoryByBin(bin.code);
      const part = stock ? await getPartBySku(stock.sku) : null;

      logTool(
        GET_BIN_STATUS_TOOL_NAME,
        `binCode="${bin.code}"`,
        stock ? `${bin.status} holding ${stock.sku} x${stock.quantity}` : `${bin.status} empty`,
      );

      return {
        found: true as const,
        code: bin.code,
        status: bin.status,
        capacity: bin.capacity,
        inventory: stock
          ? {
              sku: stock.sku,
              canonicalName: part?.canonicalName ?? null,
              quantity: stock.quantity,
            }
          : null,
      };
    } catch (err) {
      return toolFailure(GET_BIN_STATUS_TOOL_NAME, err);
    }
  },
});
