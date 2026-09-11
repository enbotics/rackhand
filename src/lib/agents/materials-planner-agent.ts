import { Agent } from "@strands-agents/sdk";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { z } from "zod";
import { createWarehouseModel } from "./model";
import { attachTraceHooks } from "@/lib/observability/strands-hooks";
import { MATERIALS_PLANNER_PROMPT } from "./materials-planner-prompt";
import { searchCatalogTool } from "./tools/search-catalog";
import { searchInventoryTool } from "./tools/search-inventory";

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

/** Read-only: search_catalog + search_inventory only. Never moves anything. */
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
    tools: [searchCatalogTool, searchInventoryTool],
    printer: false,
  });
  attachTraceHooks(agent);
  return agent;
}
