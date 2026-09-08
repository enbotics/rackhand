import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { getLatestInventoryAudit } from "@/lib/warehouse/inventory-audit-service";
import { confidencePercent } from "@/lib/warehouse/audit-types";

export const GET_LATEST_INVENTORY_AUDIT_TOOL_NAME = "get_latest_inventory_audit";

export const getLatestInventoryAuditTool = tool({
  name: GET_LATEST_INVENTORY_AUDIT_TOOL_NAME,
  description: "Read the latest persisted inventory audit and its per-bin results. Never starts movement and never changes inventory.",
  inputSchema: z.object({}),
  callback: async () => {
    const run = await getLatestInventoryAudit();
    if (!run) return { found: false as const, message: "No inventory audit has been recorded." };
    return {
      found: true as const,
      auditRunId: run.id,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      binsPlanned: run.binsPlanned,
      binsCompleted: run.binsCompleted,
      verifiedBins: run.verifiedBins,
      reconciledBins: run.reconciledBins,
      reviewRequiredBins: run.reviewRequiredBins,
      failedBins: run.failedBins,
      bins: run.binAudits.map((audit) => ({
        binCode: audit.bin.code,
        sku: audit.expectedPart?.sku ?? null,
        status: audit.status,
        expectedQuantity: audit.expectedQuantity,
        observedQuantity: audit.observedQuantity,
        confidencePercent:
          audit.countConfidence === null ? null : confidencePercent(audit.countConfidence),
        inventoryUpdated: audit.inventoryUpdated,
        reason: audit.errorCode,
      })),
    };
  },
});
