/**
 * verify_materials_availability — the deterministic other half of the
 * build-plan flow, called immediately after materials_planner returns.
 *
 * Deliberately NOT an Agent-as-Tool: it is a thin adapter over
 * runMaterialsAvailabilityCheck, the same shape as execute_retrieval and
 * execute_putaway — a plain service call, no nested LLM reasoning, because
 * the bins to audit are already known from the requirements list. This is
 * also the one approval-free physical tool in the app (see its entry in
 * APPROVAL_FREE_TOOL_NAMES in index.ts for why that's a deliberate, narrow
 * exception rather than an oversight).
 *
 * IT DOES NOT WAIT FOR THE SWEEP. The callback schedules the check via
 * next/server's after() — the exact primitive the camera upload route
 * already uses to run Gemini analysis after acknowledging the Pi — and
 * returns immediately. That is what lets the HTTP response carrying the
 * Planner's requirements card reach the operator before the sweep starts,
 * so there is something to watch rather than one long blocked request.
 * Progress and the final report are discovered by the client afterward via
 * polling (/api/warehouse/materials-plan/latest), not through this tool call.
 */
import { after } from "next/server";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { runMaterialsAvailabilityCheck } from "@/lib/warehouse/materials-plan-service";
import { getContextWorkflowSessionId } from "../request-context";
import { logTool, toolFailure } from "./tool-logging";

export const VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME = "verify_materials_availability";

export const verifyMaterialsAvailabilityInputSchema = z.object({
  requirements: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        purpose: z.string().trim().min(1),
        category: z.string().trim().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const verifyMaterialsAvailabilityTool = tool({
  name: VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
  description:
    "Start an unattended stock check for the exact requirements materials_planner just returned. THIS TOOL MOVES BINS but never pauses for approval and never waits for a human to press a capture button — call it immediately with materials_planner's own requirements as your very next action. It returns right away; the check itself runs in the background and its progress and final required/available report appear on their own card, not in this tool's result.",
  inputSchema: verifyMaterialsAvailabilityInputSchema,
  callback: async ({ requirements }) => {
    try {
      const ownerSessionId = getContextWorkflowSessionId();
      after(() =>
        new Promise((resolve) => setTimeout(resolve, 3_000)).then(() =>
          runMaterialsAvailabilityCheck({ requirements, ownerSessionId }).catch((err) => {
            console.error("[verify_materials_availability] background sweep failed:", err);
          }),
        ),
      );
      logTool(
        VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
        `skus=${requirements.map((r) => r.sku).join(",")}`,
        "started",
      );
      return { started: true, requirementCount: requirements.length };
    } catch (err) {
      return toolFailure(VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME, err);
    }
  },
});
