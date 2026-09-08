import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { confidencePercent } from "@/lib/warehouse/audit-types";
import { getInventoryAuditHistory } from "@/lib/warehouse/inventory-audit-service";

export const GET_INVENTORY_AUDIT_HISTORY_TOOL_NAME = "get_inventory_audit_history";

export const getInventoryAuditHistoryTool = tool({
  name: GET_INVENTORY_AUDIT_HISTORY_TOOL_NAME,
  description:
    "Read prior persisted inventory audits and snapshot evidence, optionally for one bin. Never moves the gantry or changes inventory.",
  inputSchema: z.object({
    binCode: z.string().trim().min(1).max(20).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  callback: async ({ binCode, limit }) => {
    const runs = await getInventoryAuditHistory({ binCode, limit });
    return {
      found: runs.length > 0,
      runs: runs.map((run) => ({
        auditRunId: run.id,
        status: run.status,
        trigger: run.trigger,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        bins: run.binAudits.map((audit) => ({
          binCode: audit.bin.code,
          sku: audit.expectedPart?.sku ?? null,
          status: audit.status,
          expectedQuantity: audit.expectedQuantity,
          observedQuantity: audit.observedQuantity,
          confidencePercent:
            audit.countConfidence === null ? null : confidencePercent(audit.countConfidence),
          inventoryUpdated: audit.inventoryUpdated,
          evidenceUrl: audit.evidenceUrl,
          reason: audit.errorCode,
        })),
      })),
    };
  },
});
