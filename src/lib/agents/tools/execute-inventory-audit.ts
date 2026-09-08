import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runInventoryAudit } from "@/lib/warehouse/inventory-audit-service";

export const EXECUTE_INVENTORY_AUDIT_TOOL_NAME = "execute_inventory_audit";

export const executeInventoryAuditTool = tool({
  name: EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  description: "Physically audit one specified bin, or all auditable bins sequentially. THIS TOOL MOVES BINS and requires client HITL approval. It captures exactly one camera image per bin and may automatically reconcile a safe count when raw confidence is strictly above 80 percent.",
  inputSchema: z.object({
    binCode: z.string().trim().min(1).max(20).optional(),
  }),
  callback: async ({ binCode }) => runInventoryAudit({ binCode, trigger: "CLIENT" }),
});
