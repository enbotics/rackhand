import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runInventoryAudit } from "@/lib/warehouse/inventory-audit-service";

export const RUN_INVENTORY_AUDIT_TOOL_NAME = "run_inventory_audit";

export const runInventoryAuditTool = tool({
  name: RUN_INVENTORY_AUDIT_TOOL_NAME,
  description: "Run the deterministic physical inventory audit for one exact bin selected from the Warehouse Agent's current daily-activity observation. Trusted internal use only.",
  inputSchema: z.object({
    binCode: z.string().trim().min(1).max(20),
  }),
  callback: async ({ binCode }) => runInventoryAudit({ binCode, trigger: "TRUSTED_INTERNAL" }),
});
