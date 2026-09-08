import { Agent, MemoryManager } from "@strands-agents/sdk";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { z } from "zod";
import { createWarehouseModel } from "./model";
import { attachTraceHooks } from "@/lib/observability/strands-hooks";
import { INVENTORY_AUDITOR_PROMPT } from "./inventory-auditor-prompt";
import {
  getLatestInventoryAuditTool,
  GET_LATEST_INVENTORY_AUDIT_TOOL_NAME,
} from "./auditor-tools/get-latest-inventory-audit";
import {
  runInventoryAuditTool,
  RUN_INVENTORY_AUDIT_TOOL_NAME,
} from "./auditor-tools/run-inventory-audit";
import {
  getInventoryAuditHistoryTool,
  GET_INVENTORY_AUDIT_HISTORY_TOOL_NAME,
} from "./auditor-tools/get-inventory-audit-history";
import { AuditHistoryMemoryStore } from "./audit-history-memory-store";

export const INVENTORY_AUDITOR_AGENT_NAME = "inventory-auditor-agent";
export const INVENTORY_AUDITOR_TOOL_NAME = "inventory_auditor";

const INVENTORY_AUDITOR_OUTPUT = z.object({
  message: z.string().min(1).max(4000),
});

export function createInventoryAuditorAgent(input: {
  model?: Model<BaseModelConfig>;
  allowExecution?: boolean;
} = {}): Agent {
  const tools = input.allowExecution
    ? [getLatestInventoryAuditTool, getInventoryAuditHistoryTool, runInventoryAuditTool]
    : [getLatestInventoryAuditTool, getInventoryAuditHistoryTool];
  const memoryManager = new MemoryManager({
    stores: [new AuditHistoryMemoryStore()],
    // Audit history is injected automatically. The specialist does not need a
    // second, model-selected history interface beside its explicit read tools.
    searchToolConfig: false,
    addToolConfig: false,
    injection: {
      trigger: "userTurn",
      maxEntries: 3,
    },
  });
  const agent = new Agent({
    name: INVENTORY_AUDITOR_AGENT_NAME,
    description: "Specialized internal agent for physical-vs-digital inventory audits.",
    model: input.model ?? createWarehouseModel(),
    systemPrompt: INVENTORY_AUDITOR_PROMPT,
    // AgentAsTool serializes structured output ahead of any provider
    // reasoning blocks, so private reasoning never enters the orchestrator's
    // tool result and cannot be repeated to a client.
    structuredOutputSchema: INVENTORY_AUDITOR_OUTPUT,
    memoryManager,
    tools,
    printer: false,
  });
  attachTraceHooks(agent);
  return agent;
}

export const INVENTORY_AUDITOR_READ_TOOL_NAMES = [
  GET_LATEST_INVENTORY_AUDIT_TOOL_NAME,
  GET_INVENTORY_AUDIT_HISTORY_TOOL_NAME,
] as const;
export const INVENTORY_AUDITOR_EXECUTION_TOOL_NAMES = [RUN_INVENTORY_AUDIT_TOOL_NAME] as const;
