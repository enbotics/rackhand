import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runInventoryAudit } from "@/lib/warehouse/inventory-audit-service";

export const EXECUTE_INVENTORY_AUDIT_TOOL_NAME = "execute_inventory_audit";

export const executeInventoryAuditTool = tool({
  name: EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  description: "Physically audit one specified bin, or all auditable bins sequentially. THIS TOOL MOVES BINS and requires client HITL approval. It captures a camera image of the bin and automatically reconciles an equal-or-higher, safe count when raw confidence is strictly above 80 percent. A lower count, a suspected foreign object, or an uncertain/over-capacity read is never applied automatically: the bin stays at the scan station and the operator sees a live before/after comparison to confirm, retry with a fresh photo, or (with no operator present) it is safely returned and left for later review on the Warehouse dashboard.",
  inputSchema: z.object({
    binCode: z.string().trim().min(1).max(20).optional(),
  }),
  callback: async ({ binCode }) => runInventoryAudit({ binCode, trigger: "CLIENT" }),
});
