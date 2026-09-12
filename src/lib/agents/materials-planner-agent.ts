import { Agent, InvokeModelStage } from "@strands-agents/sdk";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { z } from "zod";
import { createWarehouseModel } from "./model";
import { attachTraceHooks } from "@/lib/observability/strands-hooks";
import { MATERIALS_PLANNER_PROMPT } from "./materials-planner-prompt";
import { searchCatalogTool } from "./tools/search-catalog";
import { searchInventoryTool } from "./tools/search-inventory";
import { getEngineeringPlanContextTool } from "./tools/get-engineering-plan-context";

const PLAN_CONTEXT_REQUESTED_STATE_KEY = "engineeringPlanContextRequested";

export const MATERIALS_PLANNER_AGENT_NAME = "materials-planner-agent";
export const MATERIALS_PLANNER_TOOL_NAME = "materials_planner";

const MATERIALS_PLANNER_OUTPUT = z.object({
  requirements: z.array(
    z.object({
      sku: z.string().min(1),
      purpose: z.string().min(1),
      category: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
});

/** Read-only: engineering plan + catalog + inventory. Never moves anything. */
export function createMaterialsPlannerAgent(
  input: { model?: Model<BaseModelConfig> } = {},
): Agent {
  const agent = new Agent({
    name: MATERIALS_PLANNER_AGENT_NAME,
    description: "Specialized internal agent that turns a described build into a grounded materials requirements list.",
    model: input.model ?? createWarehouseModel(),
    systemPrompt: MATERIALS_PLANNER_PROMPT,
    // Same reasoning as the inventory auditor: structured output is
    // serialized ahead of any provider reasoning blocks, so private
    // reasoning never reaches the orchestrator's tool result.
    structuredOutputSchema: MATERIALS_PLANNER_OUTPUT,
    tools: [getEngineeringPlanContextTool, searchCatalogTool, searchInventoryTool],
    printer: false,
  });
  // Every build-plan run checks the day-by-day plan before catalog work. The
  // model still supplies the project query from the delegated description;
  // the forced choice only makes the lookup reliable instead of advisory.
  agent.addMiddleware(InvokeModelStage.Input, (context) => {
    if (context.invocationState[PLAN_CONTEXT_REQUESTED_STATE_KEY] === true) return context;
    context.invocationState[PLAN_CONTEXT_REQUESTED_STATE_KEY] = true;
    return {
      ...context,
      toolChoice: { tool: { name: getEngineeringPlanContextTool.name } },
    };
  });
  attachTraceHooks(agent);
  return agent;
}
