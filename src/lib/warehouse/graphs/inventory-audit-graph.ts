import { Graph, TextBlock } from "@strands-agents/sdk";
import { Node, Status } from "@strands-agents/sdk/multiagent";
import type {
  MultiAgentInput,
  MultiAgentState,
  MultiAgentStreamEvent,
  NodeInputOptions,
  NodeResultUpdate,
} from "@strands-agents/sdk/multiagent";
import { executeBinAudit } from "../audit-bin-service";
import type { BinAuditResult } from "../audit-types";
import { prisma } from "../db";

const REQUEST_KEY = "inventoryAuditRequest";
const RESULT_KEY = "inventoryAuditResult";
const READY_KEY = "inventoryAuditReady";

export interface InventoryAuditGraphRequest {
  binAuditId: string;
  /** Browser session that owns interactive client-audit capture decisions. */
  ownerSessionId?: string | null;
}

class AuditValidateNode extends Node {
  readonly type = "inventoryAuditNode";
  constructor() {
    super("audit_validate", { description: "Validate the persisted bin audit." });
  }
  async *handle(
    _input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const request = options?.invocationState?.[REQUEST_KEY] as InventoryAuditGraphRequest | undefined;
    const audit = request?.binAuditId
      ? await prisma.binAudit.findUnique({ where: { id: request.binAuditId } })
      : null;
    const ready = Boolean(audit && audit.status === "PENDING");
    state.app.set(READY_KEY, ready);
    return {
      status: ready ? Status.COMPLETED : Status.FAILED,
      content: [new TextBlock(ready ? "Bin audit validated." : "Bin audit is not pending.")],
    };
  }
}

class AuditExecuteNode extends Node {
  readonly type = "inventoryAuditNode";
  constructor() {
    super("audit_execute", { description: "Execute camera, gantry and reconciliation workflow." });
  }
  async *handle(
    _input: MultiAgentInput,
    _state: MultiAgentState,
    options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const request = options?.invocationState?.[REQUEST_KEY] as InventoryAuditGraphRequest;
    const result = await executeBinAudit(request.binAuditId, request.ownerSessionId);
    if (options?.invocationState) options.invocationState[RESULT_KEY] = result;
    return {
      status: result.status === "FAILED" ? Status.FAILED : Status.COMPLETED,
      content: [new TextBlock(JSON.stringify({ status: result.status, binCode: result.binCode }))],
    };
  }
}

let cachedGraph: Graph | undefined;

export function createInventoryAuditGraph(): Graph {
  return new Graph({
    id: "inventory_audit",
    nodes: [new AuditValidateNode(), new AuditExecuteNode()],
    edges: [
      {
        source: "audit_validate",
        target: "audit_execute",
        handler: (state) => state.app.get(READY_KEY) === true,
      },
    ],
    maxSteps: 4,
    maxConcurrency: 1,
    timeout: 120_000,
  });
}

export async function runInventoryAuditGraph(
  request: InventoryAuditGraphRequest,
  graph: Graph = (cachedGraph ??= createInventoryAuditGraph()),
): Promise<BinAuditResult> {
  const invocationState: Record<string, unknown> = { [REQUEST_KEY]: request };
  await graph.invoke("Run one deterministic inventory bin audit.", { invocationState });
  const result = invocationState[RESULT_KEY] as BinAuditResult | undefined;
  if (!result) throw new Error("inventory_audit_graph_failed");
  return result;
}
