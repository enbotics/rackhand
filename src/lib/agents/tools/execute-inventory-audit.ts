import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runInventoryAudit } from "@/lib/warehouse/inventory-audit-service";

export const EXECUTE_INVENTORY_AUDIT_TOOL_NAME = "execute_inventory_audit";

export const executeInventoryAuditTool = tool({
  name: EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  description: "Audit one specified bin, or all auditable bins sequentially. THIS TOOL MOVES BINS and requires client HITL approval. Production captures a fresh Pi image; Simulation analyzes the next controlled fixture through the same Gemini and decision gates. A safe equal-or-higher count requires raw confidence strictly above 80 percent. A lower count, suspected foreign object, or uncertain/over-capacity result is never applied automatically: the operator sees the comparison and may confirm when safe or run the appropriate next capture.",
  inputSchema: z.object({
    binCode: z.string().trim().min(1).max(20).optional(),
  }),
  callback: async ({ binCode }) => runInventoryAudit({ binCode, trigger: "CLIENT" }),
});
