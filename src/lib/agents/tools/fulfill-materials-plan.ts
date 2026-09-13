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
import { prepareMaterialsFulfillment } from "@/lib/warehouse/materials-fulfillment-service";
import {
  getContextRequestId,
  recordContextWorkflow,
  getContextWorkflowSessionId,
  getContextBrowserScenario,
} from "../request-context";
import { controlModuleScenarioPlan } from "@/lib/warehouse/control-module-scenario";
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
    "Prepare and start physical fulfillment of every exact requirement returned by materials_planner. THIS TOOL REQUIRES OPERATOR APPROVAL. After approval it revalidates recorded shelf stock, selects enough OCCUPIED bins for all requirements, and retrieves the first to OUTPUT even when a bin already has trusted verification evidence. The server then requires a fresh-photo return for that exact bin before continuing the remaining selected bins one by one; never call execute_retrieval separately for these requirements.",
  inputSchema: fulfillMaterialsPlanInputSchema,
  callback: async ({ requirements }) => {
    try {
      // PREP means retrieve every requested stocked bin. Verification evidence
      // is deliberately not a selection gate here: checkout verifies stock,
      // then the mandatory return verifies the remainder after use.
      // The separate engineering-plan audit path keeps the stricter evidence
      // policy and may skip bins whose verification is already current.
      const demoPlan = getContextBrowserScenario() ? controlModuleScenarioPlan(getContextWorkflowSessionId()) : null;
      if (getContextBrowserScenario() && !demoPlan) {
        return { ok: false, reason: "materials_plan_invalid", message: "The browser demo is no longer active. Start the control module prep again." };
      }
      const plan = demoPlan ?? await prepareMaterialsFulfillment(requirements, {
        requireTrustedEvidence: false,
      });

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
        verifyContents: true,
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
        verificationAuditRunIds: [],
        verifiedForPlanBinCodes: [],
        remainingBinCodes: result.ok
          ? remaining.map((selection) => selection.binCode)
          : [],
      };
    } catch (error) {
      return toolFailure(FULFILL_MATERIALS_PLAN_TOOL_NAME, error);
    }
  },
});
