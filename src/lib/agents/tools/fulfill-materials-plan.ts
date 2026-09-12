/**
 * fulfill_materials_plan — approval-gated bridge from planning to movement.
 *
 * A single approved invocation performs a fresh, all-or-nothing stock
 * preflight, selects the physical bins, and retrieves only the first bin to
 * OUTPUT. The Warehouse Agent's existing checked-out return queue owns every
 * later hop: fresh-photo return of this bin, then the next selected bin.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runRetrievalGraph } from "@/lib/warehouse/graphs/retrieval-graph";
import { runInventoryAudit } from "@/lib/warehouse/inventory-audit-service";
import {
  MAX_MATERIALS_FULFILLMENT_BINS,
  prepareMaterialsFulfillment,
} from "@/lib/warehouse/materials-fulfillment-service";
import {
  getContextRequestId,
  getContextWorkflowSessionId,
  recordContextWorkflow,
} from "../request-context";
import { logTool, toolFailure } from "./tool-logging";

export const FULFILL_MATERIALS_PLAN_TOOL_NAME = "fulfill_materials_plan";

export const fulfillMaterialsPlanInputSchema = z.object({
  requirements: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        purpose: z.string().trim().min(1),
        category: z.string().trim().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(20),
});

export const fulfillMaterialsPlanTool = tool({
  name: FULFILL_MATERIALS_PLAN_TOOL_NAME,
  description:
    "Prepare and start physical fulfillment of the exact requirements returned by materials_planner. THIS TOOL REQUIRES OPERATOR APPROVAL. After approval it trusts bins whose latest accepted audit or verified putaway is newer than every inventory-changing event. It physically audits only the minimum relevant uncertain bins needed to establish the requested stock, then selects enough verified OCCUPIED bins and retrieves the first to OUTPUT. It never audits unrelated bins. The server then offers a fresh-photo return for that exact bin and continues the remaining selected bins one by one; never call execute_retrieval separately for these requirements.",
  inputSchema: fulfillMaterialsPlanInputSchema,
  callback: async ({ requirements }) => {
    try {
      const attemptedVerificationBins = new Set<string>();
      const verificationAuditRunIds: string[] = [];
      let plan = await prepareMaterialsFulfillment(requirements);

      // Re-evaluate after every physical observation. A lower reconciled
      // count can make one more relevant bin necessary; a higher count can
      // make every remaining candidate unnecessary. This is deliberately
      // one bin at a time so the workflow stops at the minimum useful work.
      while (!plan.ok && plan.reason === "materials_verification_required") {
        const next = plan.verificationTargets?.find(
          (target) => !attemptedVerificationBins.has(target.binCode),
        );
        if (!next) {
          plan = await prepareMaterialsFulfillment(requirements, {
            excludeVerificationBinCodes: [...attemptedVerificationBins],
          });
          break;
        }
        if (attemptedVerificationBins.size >= MAX_MATERIALS_FULFILLMENT_BINS) {
          return {
            ok: false as const,
            reason: "materials_plan_invalid" as const,
            message: `The plan requires more than ${MAX_MATERIALS_FULFILLMENT_BINS} physical verification trips. No fulfillment bin was retrieved.`,
            shortages: [],
            verificationAuditRunIds,
          };
        }

        attemptedVerificationBins.add(next.binCode);
        const audit = await runInventoryAudit({
          binCode: next.binCode,
          trigger: "CLIENT",
          ownerSessionId: getContextWorkflowSessionId(),
        });
        verificationAuditRunIds.push(audit.auditRunId);

        if (audit.results.some((result) => result.reason === "audit_return_failed")) {
          return {
            ok: false as const,
            reason: "materials_verification_incomplete" as const,
            message: `Verification stopped because bin ${next.binCode} could not be returned safely. No fulfillment bin was retrieved.`,
            shortages: [],
            verificationAuditRunIds,
          };
        }

        plan = await prepareMaterialsFulfillment(requirements, {
          excludeVerificationBinCodes: [...attemptedVerificationBins],
        });
      }

      if (!plan.ok) {
        logTool(
          FULFILL_MATERIALS_PLAN_TOOL_NAME,
          `skus=${requirements.map((requirement) => requirement.sku).join(",")}`,
          plan.reason,
        );
        return plan;
      }

      const [first, ...remaining] = plan.selectedBins;
      if (!first) {
        return {
          ok: false as const,
          reason: "materials_plan_invalid" as const,
          message: "The materials plan did not select a retrievable bin. No bin moved.",
        };
      }

      const requestId = getContextRequestId();
      const run = await runRetrievalGraph({
        sku: first.sku,
        sourceBinCode: first.binCode,
        requestId: requestId ? `${requestId}:fulfillment:1` : undefined,
      });
      recordContextWorkflow(run.graph);

      const result = run.result;
      logTool(
        FULFILL_MATERIALS_PLAN_TOOL_NAME,
        `first=${first.binCode} selected=${plan.selectedBins.length}`,
        result.ok ? "started" : result.reason,
      );

      return {
        ...result,
        fulfillmentWorkflow: true,
        selectedBins: plan.selectedBins,
        fulfillmentTotal: plan.selectedBins.length,
        verificationAuditRunIds,
        verifiedForPlanBinCodes: [...attemptedVerificationBins],
        remainingBinCodes: result.ok
          ? remaining.map((selection) => selection.binCode)
          : [],
      };
    } catch (error) {
      return toolFailure(FULFILL_MATERIALS_PLAN_TOOL_NAME, error);
    }
  },
});
