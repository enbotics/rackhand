/**
 * The Warehouse Agent — the client-facing orchestrator in this system.
 *
 * It owns the deterministic warehouse tools and mounts the focused Inventory
 * Auditor as an Agent-as-Tool. The auditor is not another client endpoint and
 * cannot widen the orchestrator's authority.
 *
 * A fresh orchestrator is still BUILT per invocation — tools, interventions,
 * hooks and the system prompt always come from the current server code, never
 * from anything restored. What now carries across turns is the conversation
 * itself: the operator's chat history is stored server-side per session (see
 * conversation-store.ts) and reloaded into that fresh agent, so "put it away"
 * can resolve against the retrieval the operator asked for a minute earlier
 * instead of guessing from global warehouse state.
 *
 * Only server-written state may become history. A browser supplies an opaque
 * session id, its own message, and scan DATA — never messages, tool-call blocks
 * or tool results. The Inventory Auditor's Strands memory remains a read-only
 * projection of durable, completed audit history; it cannot retain arbitrary
 * prompt text or grant authority across requests.
 *
 * The agent runs server-side only. It never receives a database handle, a
 * Prisma client, filesystem access, a shell, or arbitrary HTTP — its entire
 * capability surface is WAREHOUSE_AGENT_TOOLS plus the deliberately wrapped
 * Inventory Auditor tool constructed below.
 */
import { Agent, InterruptResponseContent } from "@strands-agents/sdk";
import type { BaseModelConfig, Message, Model, Snapshot } from "@strands-agents/sdk";
import { HumanInTheLoop } from "@strands-agents/sdk/vended-interventions/hitl";
import { WAREHOUSE_AGENT_PROMPT } from "./warehouse-prompt";
import {
  APPROVAL_FREE_TOOL_NAMES,
  APPROVAL_REQUIRED_TOOL_NAMES,
  EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  WAREHOUSE_AGENT_TOOLS,
} from "./tools";
import {
  claimApproval,
  createPendingApproval,
  settleApproval,
  type ApprovalDecision,
  type ApprovalSummary,
  type PendingApprovalView,
} from "./approval-store";
import {
  loadConversation,
  saveConversation,
  validateAgentSessionId,
} from "./conversation-store";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { getCatalogResolution } from "@/lib/warehouse/catalog-resolution-service";
import { prisma } from "@/lib/warehouse/db";
import { listPutawayDestinations } from "@/lib/warehouse/repository";
import { getInventoryForPart } from "@/lib/warehouse/inventory-service";
import { chooseRetrievalSourceBinCode } from "@/lib/warehouse/retrieval-service";
import { compareBinsInShelfOrder } from "@/lib/warehouse/bin-layout";
import { createWarehouseModel, getBedrockModelId } from "./model";
import { AgentError, classifyAgentFailure } from "./errors";
import { createRequestId, getContextWorkflows, runWithRequestContext } from "./request-context";
import {
  completeTrace,
  recordEvent,
  setTraceStatus,
  startTrace,
} from "@/lib/observability/trace-service";
import {
  attachTraceHooks,
  failedToolNames,
  TRACE_ID_STATE_KEY,
} from "@/lib/observability/strands-hooks";
import { sanitizeError } from "@/lib/observability/sanitize";
import type { TraceStatus } from "@/lib/observability/types";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import { collectScanResultIssues } from "@/lib/warehouse/scan-result";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import {
  createInventoryAuditorAgent,
  INVENTORY_AUDITOR_TOOL_NAME,
} from "./inventory-auditor-agent";

export const WAREHOUSE_AGENT_NAME = "warehouse-agent";
export type WarehouseApprovalMode = "CLIENT" | "TRUSTED_INTERNAL";

/** Documented MVP cap on a single operator message. */
export const MAX_AGENT_MESSAGE_LENGTH = 4000;

/**
 * Builds the main Warehouse Agent and its scoped Inventory Auditor tool.
 *
 * `model` exists as a seam so tests can drive the REAL tool list and the REAL
 * intervention configuration with a scripted model instead of Bedrock. Nothing
 * in production passes it.
 */
export function createWarehouseAgent(
  model: Model<BaseModelConfig> = createWarehouseModel(),
  approvalMode: WarehouseApprovalMode = "CLIENT",
): Agent {
  const inventoryAuditor = createInventoryAuditorAgent({
    model,
    // This mode is selected by trusted server code, never by prompt text.
    // Client delegation stays read-only; physical client audits must pass
    // through execute_inventory_audit and the main agent's HITL gate.
    allowExecution: approvalMode === "TRUSTED_INTERNAL",
  });
  const inventoryAuditorTool = inventoryAuditor.asTool({
    name: INVENTORY_AUDITOR_TOOL_NAME,
    description:
      "Ask the specialist Inventory Auditor to explain the latest audit or, in trusted internal mode only, run a sequential physical bin audit. Client physical audit requests must use execute_inventory_audit so human approval cannot be bypassed.",
    preserveContext: false,
  });
  const orchestratorTools =
    approvalMode === "TRUSTED_INTERNAL"
      ? WAREHOUSE_AGENT_TOOLS.filter(
          (candidate) => candidate.name !== EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
        )
      : WAREHOUSE_AGENT_TOOLS;

  const agent = new Agent({
    name: WAREHOUSE_AGENT_NAME,
    model,
    systemPrompt: WAREHOUSE_AGENT_PROMPT,
    tools: [...orchestratorTools, inventoryAuditorTool],
    /**
     * Human-in-the-loop (Milestone 9). Read-only tools are listed and run
     * freely; execute_putaway, execute_retrieval and
     * execute_inventory_audit pause
     * the agent with `stopReason: "interrupt"`
     * before the tool callback runs, so no warehouse state can change until a
     * person answers. The default (no classifier) is "approval required", so a
     * tool added later is gated unless someone deliberately allows it.
     */
    interventions:
      approvalMode === "CLIENT"
        ? [new HumanInTheLoop({ allowedTools: [...APPROVAL_FREE_TOOL_NAMES] })]
        : [],
    // SDK console printing off: this runs behind an API, and application logs
    // should stay clean and free of prompt content.
    printer: false,
  });

  /**
   * Observability (Milestone 12). Two PASSIVE hooks on the SDK's own tool
   * lifecycle — they read `toolUse`, they never set `cancel`, `retry` or
   * `selectedTool`. Tool activity is discovered from these events rather than
   * from console output or patched internals.
   */
  attachTraceHooks(agent);
  return agent;
}

/**
 * Explicit server-only construction path for trusted Agent-as-Tool execution.
 * The caller chooses this path in code; neither user text nor the model can
 * switch a client invocation into it.
 */
export function createTrustedWarehouseAgent(
  model: Model<BaseModelConfig> = createWarehouseModel(),
): Agent {
  return createWarehouseAgent(model, "TRUSTED_INTERNAL");
}

const TRUSTED_ACTIVITY_OBSERVATION_PROMPT =
  "Review the current rolling 24-hour warehouse activity. If exactly one shelf bin is currently eligible for a useful audit, choose the strongest candidate from the observed database evidence and delegate that exact bin to the Inventory Auditor. Otherwise perform no physical action and briefly report why.";

/**
 * Server-only, event-invoked observation entry point.
 *
 * Nothing in this module schedules it. A trusted warehouse runtime may call it
 * while the main agent is already active/idle; browser text cannot select this
 * construction path or turn off HITL for an ordinary client request.
 */
export function invokeTrustedWarehouseObservation(
  requestId: string = createRequestId(),
): Promise<WarehouseAgentReply> {
  return invokeWarehouseAgent(
    TRUSTED_ACTIVITY_OBSERVATION_PROMPT,
    undefined,
    requestId,
    null,
    createTrustedWarehouseAgent,
  );
}

/**
 * The terminal trace status for a turn.
 *
 * Derived from the WORKFLOWS the turn ran, not from the model's wording. A
 * blocked catalog match and a failed gantry are both "the action did not
 * happen", and an operator scanning a list of runs needs them to look
 * different.
 */
function terminalStatusFor(
  workflows: WarehouseGraphResult[],
  /** Tools that failed outright this turn, from the observability hooks (Milestone 13). */
  failedTools: readonly string[] = [],
): TraceStatus {
  if (workflows.some((workflow) => workflow.status === "FAILED")) return "FAILED";

  /**
   * A write tool that THREW — an unexpected service fault, or arguments that
   * failed their schema — records no workflow at all, so the checks above
   * cannot see it and the turn was previously reported COMPLETED. An operator
   * scanning the activity list saw a green run for a physical action that
   * never happened.
   *
   * Only write tools count, and only when nothing else succeeded. A read-only
   * tool that failed and was retried is noise, and a live run showed exactly
   * that: Nova called match_catalog with bad arguments, corrected itself, and
   * went on to store the part. That run completed, and must say so.
   */
  const wroteSomething = workflows.some((workflow) => workflow.status === "COMPLETED");
  const writeToolFailed = failedTools.some((name) =>
    (APPROVAL_REQUIRED_TOOL_NAMES as readonly string[]).includes(name),
  );
  if (writeToolFailed && !wroteSomething) return "FAILED";

  if (workflows.some((workflow) => workflow.status === "BLOCKED")) return "BLOCKED";
  return "COMPLETED";
}

/**
 * A small, stable slice of the Strands `AgentResult.metrics`.
 *
 * Everything is optional and everything is guarded: a trace must never depend
 * on the SDK reporting metrics, and token counts matter far less here than
 * whether the warehouse did what it was asked.
 */
function traceMetricsFrom(result: { metrics?: unknown }): {
  modelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelLatencyMs: number | null;
} | null {
  const metrics = result.metrics as
    | {
        cycleCount?: number;
        accumulatedUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        accumulatedMetrics?: { latencyMs?: number };
      }
    | undefined;
  if (!metrics) return null;
  return {
    modelCalls: metrics.cycleCount ?? null,
    inputTokens: metrics.accumulatedUsage?.inputTokens ?? null,
    outputTokens: metrics.accumulatedUsage?.outputTokens ?? null,
    totalTokens: metrics.accumulatedUsage?.totalTokens ?? null,
    modelLatencyMs: metrics.accumulatedMetrics?.latencyMs ?? null,
  };
}

export interface WarehouseAgentReply {
  /** COMPLETED — the turn finished. APPROVAL_REQUIRED — a person must decide. */
  status: "COMPLETED" | "APPROVAL_REQUIRED";
  message: string;
  agent: string;
  model: string;
  /** Names of tools the model actually called, in order. Never reasoning. */
  toolCalls: string[];
  /** Present only when status is APPROVAL_REQUIRED. */
  approval?: PendingApprovalView;
  /**
   * The observability trace for this turn (Milestone 12). Server-generated —
   * a browser-supplied id is never trusted or used — and preserved across a
   * HITL pause, so the dashboard follows one timeline through an approval.
   */
  traceId: string;
  /**
   * Strands graph workflow runs this turn (Milestone 11), oldest first.
   *
   * Sanitized orchestration state — node ids, statuses and one-line summaries
   * built from warehouse facts. Never raw SDK objects, model output or
   * reasoning. Absent when the turn ran no state-changing workflow, which is
   * every read-only question.
   */
  workflows?: WarehouseGraphResult[];
}

/** Validates one operator message. Throws agent_invalid_request with every issue found. */
export function validateAgentMessage(value: unknown): string {
  const issues: string[] = [];

  if (typeof value !== "string") {
    issues.push("message must be a string");
  } else if (value.trim() === "") {
    issues.push("message must not be empty");
  } else if (value.length > MAX_AGENT_MESSAGE_LENGTH) {
    issues.push(`message must be at most ${MAX_AGENT_MESSAGE_LENGTH} characters`);
  }

  if (issues.length > 0) throw new AgentError("agent_invalid_request", issues);
  return (value as string).trim();
}

/**
 * Validates a ScanResult supplied alongside an operator message.
 *
 * Validated INDEPENDENTLY of the message, and against the same
 * `collectScanResultIssues` rule set /api/measure and the catalog matcher use
 * — a browser payload is never trusted just because it arrived next to a
 * plausible question.
 *
 * Absent is legitimate: most questions have no scan. Present-but-malformed is
 * an error, because silently dropping it would leave the agent answering as
 * though no scan existed.
 */
export function validateAgentScanResult(value: unknown): ScanResult | null {
  if (value === undefined || value === null) return null;

  const issues = collectScanResultIssues(value);
  if (issues.length > 0) {
    throw new AgentError(
      "agent_invalid_request",
      issues.map((issue) => `scanResult: ${issue}`),
    );
  }
  return value as ScanResult;
}

/** Validates the camera evidence that may authorize a later putaway. */
export function validateScanImageDataUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ||
    value.length > 7_000_000
  ) {
    throw new AgentError("agent_invalid_request", [
      "scanImageDataUrl must be a base64 image data URL no larger than 7 MB",
    ]);
  }
  return value;
}

/**
 * Server-authored, constant. It tells the model a scan exists without putting
 * one byte of scan-derived text into the conversation — no detectedName, no
 * description — so a hostile label on a scanned part cannot reach the model as
 * something that looks like an instruction. The scan itself travels
 * out-of-band via request-context.ts.
 */
export const IDENTITY_RESOLVED_NOTICE =
  "[system: the operator has already confirmed which catalog part this scan is. The confirmed identity is attached to this request and execute_putaway will revalidate it. Do not ask them to identify it again, and do not treat the ambiguous match as a blocker.]";

export const SCAN_ATTACHED_NOTICE =
  "[system: a validated ScanResult is attached to this request. Use the match_catalog tool to compare it against the catalog. Do not ask the operator to paste scan data.]";

/**
 * Inline reasoning wrappers some models emit *inside* a normal text block.
 *
 * Filtering `reasoningBlock` is not sufficient on its own: Amazon Nova (and
 * others) write their scratchpad into the visible text as `<thinking>…</thinking>`,
 * which reached the client verbatim until this was added.
 */
const INLINE_REASONING_TAGS = ["thinking", "reasoning", "scratchpad", "reflection"];

/** Paired tags, e.g. `<thinking> … </thinking>`, across newlines. */
const PAIRED_REASONING = new RegExp(
  `<(${INLINE_REASONING_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  "gi",
);

/**
 * An unclosed opener — the model was cut off mid-scratchpad by maxTokens.
 * Everything after it is reasoning, so the tail is dropped rather than shown.
 */
const UNCLOSED_REASONING = new RegExp(
  `<(?:${INLINE_REASONING_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`,
  "i",
);

/**
 * Some models wrap their whole answer in `<response>…</response>`. That is not
 * reasoning — it is the answer — so it is unwrapped rather than dropped.
 * Observed live with Nova; without this the client renders the literal tags.
 */
const RESPONSE_ENVELOPE = /^<response\b[^>]*>([\s\S]*?)<\/response\s*>$/i;
/** Same envelope, cut short by maxTokens: keep what came after the opener. */
const UNCLOSED_RESPONSE = /^<response\b[^>]*>([\s\S]*)$/i;

/** Strips inline chain-of-thought and tidies the whitespace it leaves behind. */
export function stripInlineReasoning(text: string): string {
  const stripped = text
    .replace(PAIRED_REASONING, "")
    .replace(UNCLOSED_REASONING, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const enveloped = stripped.match(RESPONSE_ENVELOPE) ?? stripped.match(UNCLOSED_RESPONSE);
  return enveloped ? enveloped[1].trim() : stripped;
}

/**
 * The assistant's visible answer.
 *
 * Two separate defences, because models leak reasoning two different ways:
 *  - `reasoningBlock` content is dropped by filtering to `textBlock` only
 *    (`AgentResult.toString()` would concatenate both, so it is not used).
 *  - inline `<thinking>` markup inside a text block is stripped after.
 * Private chain-of-thought must never reach a client.
 */
function extractVisibleText(message: Message): string {
  const visible = message.content
    .filter((block) => block.type === "textBlock")
    .map((block) => block.text)
    .join("\n");

  return stripInlineReasoning(visible);
}

/* --------------------------------------------------- conversation memory */

/**
 * Captures the conversation for the session store.
 *
 * `systemPrompt` is excluded deliberately: the safety policy must always be the
 * one this build ships, never one frozen into a snapshot before it was edited.
 * `interrupts` are excluded because a parked interrupt is the approval store's
 * property — resuming it is that store's job, and a copy loose in the session
 * store could only ever be a stale second key to the same physical action.
 *
 * JSON round-tripped for the same reason parkForApproval does it: what is
 * retained must be inert data, not a live object graph holding a model client
 * or AWS credentials.
 */
function captureConversation(agent: Agent): Snapshot {
  return JSON.parse(
    JSON.stringify(
      agent.takeSnapshot({ preset: "session", exclude: ["systemPrompt", "interrupts"] }),
    ),
  ) as Snapshot;
}

/**
 * Restores this session's history into a freshly built agent.
 *
 * The agent is still constructed from server code every turn — only the message
 * history is restored — so tools, interventions and hooks can never be
 * inherited from an older process state.
 */
function restoreConversation(agent: Agent, sessionId: string | null): void {
  const snapshot = loadConversation(sessionId);
  if (snapshot) agent.loadSnapshot(snapshot);
}

/**
 * Stores the conversation after a turn, but ONLY when the turn actually ended.
 *
 * A turn that stopped on an interrupt has an uncommitted tool call and a
 * history that ends on a user-role message; persisting that would both leave a
 * half-finished exchange as the session's memory and risk handing the provider
 * two consecutive user messages on the next turn. The parked approval carries
 * the session id instead, so whichever way the operator decides, the RESUMED
 * run — which does end on a proper assistant message — is what gets stored.
 */
function persistConversation(
  sessionId: string | null,
  agent: Agent,
  stopReason: string,
): void {
  if (!sessionId || stopReason === "interrupt") return;
  saveConversation(sessionId, captureConversation(agent));
}

/**
 * The last message before an invocation, used as a marker so the tool calls
 * reported to the client are THIS turn's and not the whole session's.
 *
 * Identity rather than an index: the sliding-window conversation manager may
 * trim the front of the array during a long session, which would silently
 * shift any index recorded beforehand.
 */
function conversationMarker(agent: Agent): Message | null {
  return agent.messages.at(-1) ?? null;
}

/** Messages appended since `marker`; the whole history when it has been trimmed away. */
function messagesSince(agent: Agent, marker: Message | null): Message[] {
  if (!marker) return [...agent.messages];
  const index = agent.messages.indexOf(marker);
  return index === -1 ? [...agent.messages] : agent.messages.slice(index + 1);
}

/** Tool names the model invoked this turn — operational trace, not reasoning. */
function extractToolCalls(messages: readonly Message[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "toolUseBlock") names.push(block.name);
    }
  }
  return names;
}

/**
 * Shown when the model produced no visible text — normally because its whole
 * reply was inline reasoning, which is stripped. Observed live with Nova on a
 * question no available tool can answer. A blank bubble is worse than a plain
 * statement of what this agent can do, and inventing an answer is not an
 * option, so the fallback is fixed text that promises nothing.
 */
export const EMPTY_REPLY_FALLBACK =
  "I could not produce an answer for that. I can inspect catalog, inventory, bins, scans, gantry and audit state, and I can request approved putaway, whole-bin retrieval or physical inventory-audit operations.";

/**
 * Runs one Warehouse Agent turn.
 *
 * With a `sessionId` the turn continues that session's server-stored
 * conversation; without one it is a single isolated exchange, which is how the
 * smoke-test script and the trusted observation path run.
 *
 * Throws an AgentError whose message is always a fixed safe string; the
 * underlying provider error is logged server-side and never returned.
 */
export async function invokeWarehouseAgent(
  rawMessage: unknown,
  rawScanResult?: unknown,
  requestId: string = createRequestId(),
  catalogResolutionId?: string | null,
  /** Test seam: build the agent with a scripted model instead of Bedrock. */
  createAgent: () => Agent = createWarehouseAgent,
  rawScanImageDataUrl?: unknown,
  /**
   * An opaque per-chat handle. The ONLY conversational thing a browser may
   * send: it selects server-owned history, it can never supply or edit it.
   */
  rawSessionId?: unknown,
): Promise<WarehouseAgentReply> {
  // Validated independently, and all before the model is constructed.
  const message = validateAgentMessage(rawMessage);
  const scanResult = validateAgentScanResult(rawScanResult);
  const scanImageDataUrl = validateScanImageDataUrl(rawScanImageDataUrl);
  const sessionId = validateAgentSessionId(rawSessionId);

  // Milestone 12. Server-generated: a browser may not choose its own trace id,
  // and the summary is the operator's own words, truncated — never the system
  // prompt or the notices appended below.
  const traceId = await startTrace({ requestSummary: message });
  await recordEvent(traceId, {
    type: "AGENT_STARTED",
    status: "STARTED",
    name: WAREHOUSE_AGENT_NAME,
    summary: "Warehouse request received.",
    startedAt: new Date(),
    metadata: {
      requestId,
      ...(scanResult ? { scanId: scanResult.scanId } : {}),
      ...(catalogResolutionId ? { catalogResolutionId } : {}),
    },
  });

  const agent = createAgent();
  // Everything the model will treat as "what happened earlier" comes from here
  // — state this server wrote at the end of a previous turn of THIS session.
  restoreConversation(agent, sessionId);
  const marker = conversationMarker(agent);
  // Server-authored constants only — no scan- or catalog-derived text ever
  // reaches the model this way, so a hostile label cannot become instruction.
  const notices = [
    scanResult ? SCAN_ATTACHED_NOTICE : null,
    catalogResolutionId ? IDENTITY_RESOLVED_NOTICE : null,
  ].filter(Boolean);
  const prompt = notices.length > 0 ? `${message}\n\n${notices.join("\n")}` : message;

  // The trace id travels in the SDK's own per-invocation state, which is what
  // the tool hooks read — that is the documented channel for correlation
  // metadata, and it keeps the hooks independent of this application's
  // async-local context. Held in a variable rather than inlined because the
  // hooks also record a tool failure here, which the turn's status depends on.
  const invocationState: Record<string, unknown> = { [TRACE_ID_STATE_KEY]: traceId };

  try {
    // The scan reaches match_catalog through request-scoped storage, never
    // through the message history the model can author.
    // The workflow log is read INSIDE the context, where the async-local store
    // still exists — outside it, the store is gone and the graphs' progress
    // with it.
    const { result, workflows } = await runWithRequestContext(
      {
        scanResult,
        scanImageDataUrl,
        requestId,
        catalogResolutionId,
        traceId,
        workflowSessionId: sessionId,
      },
      async () => {
        const invocation = await agent.invoke(prompt, { invocationState });
        return { result: invocation, workflows: getContextWorkflows() };
      },
    );
    // This turn's calls only — with a restored session, `agent.messages` also
    // holds every earlier turn's, which the operator has already been shown.
    const toolCalls = extractToolCalls(messagesSince(agent, marker));
    persistConversation(sessionId, agent, result.stopReason);

    console.log(
      `[warehouse-agent] invocation completed stopReason=${result.stopReason} tools=${toolCalls.join(",") || "none"} scan=${scanResult ? scanResult.scanId : "none"} session=${sessionId ? "yes" : "none"}`,
    );

    // A state-changing tool was intercepted before it ran. Nothing has
    // executed: the snapshot is parked and a person now decides.
    if (result.stopReason === "interrupt" && result.interrupts?.length) {
      const approval = await parkForApproval({
        agent,
        interruptId: result.interrupts[0].id,
        interruptReason: result.interrupts[0].reason,
        requestId,
        scanResult,
        scanImageDataUrl,
        catalogResolutionId: catalogResolutionId ?? null,
        traceId,
        // Carried server-side, never re-sent by the browser, so the decision
        // that finishes this action lands back in the conversation it began in.
        sessionId,
      });
      await recordEvent(traceId, {
        type: "APPROVAL_REQUIRED",
        status: "BLOCKED",
        name: approval.action,
        summary: `${approval.summary.action} of ${approval.summary.sku ?? "an unidentified part"} is waiting for operator approval.`,
        metadata: {
          approvalId: approval.approvalId,
          tool: approval.action,
          sku: approval.summary.sku,
          source: approval.summary.source,
          destination: approval.summary.destination,
        },
      });
      // Not terminal: the same trace continues when a person decides.
      await setTraceStatus(traceId, "WAITING_FOR_APPROVAL");

      return {
        status: "APPROVAL_REQUIRED",
        message: approvalPrompt(approval.summary),
        agent: WAREHOUSE_AGENT_NAME,
        model: getBedrockModelId(),
        toolCalls,
        traceId,
        approval,
        ...(workflows.length > 0 ? { workflows } : {}),
      };
    }

    const visible = extractVisibleText(result.lastMessage);

    const status = terminalStatusFor(workflows, failedToolNames(invocationState));
    await recordEvent(traceId, {
      type: "AGENT_COMPLETED",
      status: status === "COMPLETED" ? "COMPLETED" : "BLOCKED",
      name: WAREHOUSE_AGENT_NAME,
      summary: `Request ${status.toLowerCase()}.`,
      completedAt: new Date(),
      metadata: { tools: toolCalls, status },
    });
    await completeTrace(traceId, { status, metrics: traceMetricsFrom(result) });

    return {
      status: "COMPLETED",
      message: visible || EMPTY_REPLY_FALLBACK,
      agent: WAREHOUSE_AGENT_NAME,
      model: getBedrockModelId(),
      toolCalls,
      traceId,
      ...(workflows.length > 0 ? { workflows } : {}),
    };
  } catch (err) {
    // Full detail stays on the server; the client gets a classified code only.
    console.error("[warehouse-agent] invocation failed:", err);
    const classified = classifyAgentFailure(err);
    await recordEvent(traceId, {
      type: "AGENT_FAILED",
      status: "FAILED",
      name: WAREHOUSE_AGENT_NAME,
      // The classified code and its fixed safe message. Never the provider's
      // own text, and never a stack trace.
      summary: classified.message,
      completedAt: new Date(),
      metadata: { code: classified.code },
    });
    await completeTrace(traceId, {
      status: "FAILED",
      error: { code: classified.code, message: sanitizeError(classified).message },
    });
    throw classified;
  }
}

/* ------------------------------------------------- human-in-the-loop */

/** Operator-facing sentence for an approval card. Never model text. */
function approvalPrompt(summary: ApprovalSummary): string {
  if (summary.action === "INVENTORY_AUDIT") {
    return (
      `Approval required: physically audit ${summary.source ?? "the auditable shelf bins"}. ` +
      "Each bin will travel to SCAN_STATION, receive one camera count, and return before any safe reconciliation. " +
      "Nothing has been moved and no inventory has changed yet."
    );
  }
  const what = summary.sku ? `${summary.sku}${summary.canonicalName ? ` (${summary.canonicalName})` : ""}` : "this part";
  const capacity = summary.capacity
    ? ` Capacity ${summary.capacity.before} → ${summary.capacity.after}/${summary.capacity.limit}.`
    : "";
  return (
    `Approval required: ${summary.action} of ${what}, ` +
    `${summary.source ?? "?"} \u2192 ${summary.destination ?? "?"}, ` +
    `${summary.scope === "ENTIRE_BIN" ? "entire physical bin" : `camera-counted quantity ${summary.quantity ?? "pending"}`}. ` +
    capacity +
    "Nothing has been moved yet."
  );
}

/**
 * Recovers the tool call an interrupt belongs to, from the interrupt itself.
 *
 * Message history is NOT a source here: when the agent stops with
 * `stopReason: "interrupt"`, the assistant turn carrying the toolUseBlock has
 * not been committed yet — `agent.messages` still holds only the user message.
 * The interrupt's `reason` is the only place the tool name and the exact
 * arguments are available, in the SDK's format:
 *
 *     Approve "execute_retrieval"?
 *       Input: {"sku":"BRG-6204","quantity":1}
 *
 * That format is presentation and an SDK upgrade could change it, so parsing
 * is defensive and a test asserts it still works. Crucially this only feeds
 * the operator's summary card: the arguments that actually EXECUTE come from
 * the Strands snapshot on resume, never from this parse, so a format change
 * would degrade the card and could not misroute an operation.
 */
const INTERRUPT_REASON = /^Approve\s+"([^"]+)"\?[\s\S]*?Input:\s*([\s\S]*)$/;

export function parseInterruptReason(reason: unknown): { name: string; input: unknown } | null {
  if (typeof reason !== "string") return null;
  const match = reason.match(INTERRUPT_REASON);
  if (!match) return null;

  let input: unknown = null;
  try {
    input = JSON.parse(match[2].trim());
  } catch {
    // A card without arguments is still safe.
  }
  return { name: match[1], input };
}

/**
 * Builds the sanitized card the operator sees.
 *
 * For a putaway the part is not in the tool arguments — it comes from the scan
 * — so the deterministic matcher is re-run to name it. That is a read-only
 * call, and a card saying "PUTAWAY of something" would be useless.
 */
async function summarizeToolCall(
  toolName: string,
  input: unknown,
  scanResult: ScanResult | null,
  catalogResolutionId: string | null,
): Promise<ApprovalSummary> {
  const args = (input ?? {}) as Record<string, unknown>;

  if (toolName === "execute_inventory_audit") {
    const requestedBin =
      typeof args.binCode === "string" && args.binCode.trim() !== ""
        ? args.binCode.trim().toUpperCase()
        : null;
    return {
      action: "INVENTORY_AUDIT",
      sku: null,
      canonicalName: null,
      source: requestedBin ?? "all auditable shelf bins",
      destination: "SCAN_STATION → original slot",
      quantity: null,
      scope: "AUDIT_BINS",
      capacity: null,
    };
  }

  if (toolName === "execute_retrieval") {
    const part =
      typeof args.sku === "string"
        ? await prisma.part.findUnique({ where: { sku: args.sku.trim().toUpperCase() } })
        : typeof args.partId === "string"
          ? await prisma.part.findUnique({ where: { id: args.partId.trim() } })
          : null;
    const inventory = part ? await getInventoryForPart(part.sku) : null;
    const stocked =
      inventory?.locations.filter(
        (location) => location.binStatus === "OCCUPIED" && location.quantity > 0,
      ) ?? [];
    const source =
      typeof args.sourceBinCode === "string"
        ? args.sourceBinCode.trim().toUpperCase()
        : chooseRetrievalSourceBinCode(stocked) ?? "(chosen at execution)";
    const recordedQuantity = stocked.find((location) => location.binCode === source)?.quantity ?? null;
    return {
      action: "RETRIEVAL",
      sku: part?.sku ?? (typeof args.sku === "string" ? args.sku : null),
      canonicalName: part?.canonicalName ?? null,
      source,
      destination: "OUTPUT",
      quantity: recordedQuantity,
      scope: "ENTIRE_BIN",
      capacity: null,
    };
  }

  // A named checkout takes precedence over a stale attached intake scan.
  // This preview shows the baseline that the fresh verification will compare.
  if (toolName === "execute_putaway" && (!scanResult || typeof args.binCode === "string")) {
    const requestedCode =
      typeof args.binCode === "string" && args.binCode.trim() !== ""
        ? args.binCode.trim().toUpperCase()
        : null;
    const checkedOutBins = await prisma.bin.findMany({
      where: {
        status: "CHECKED_OUT",
        ...(requestedCode ? { code: requestedCode } : {}),
      },
      include: { inventory: { where: { quantity: { gt: 0 } }, include: { part: true } } },
    });
    const bin =
      (requestedCode
        ? checkedOutBins[0]
        : checkedOutBins.length === 1
          ? checkedOutBins[0]
          : undefined) ?? null;
    const row = bin?.inventory[0] ?? null;
    return {
      action: "PUTAWAY",
      sku: row?.part.sku ?? null,
      canonicalName: row?.part.canonicalName ?? null,
      source: "OUTPUT",
      destination: bin?.code ?? requestedCode ?? "(chosen at execution)",
      quantity: row?.quantity ?? null,
      scope: "ENTIRE_BIN",
      capacity: null,
    };
  }

  let sku: string | null = null;
  let canonicalName: string | null = null;
  let resolvedPartId: string | null = null;

  const putawayRoute = async (
    partId: string,
    quantity: number,
  ): Promise<{
    source: string;
    destination: string;
    capacity: { before: number; after: number; limit: number } | null;
  }> => {
    const checkedOutBins = await prisma.bin.findMany({
      where: { status: "CHECKED_OUT", inventory: { some: { partId, quantity: { gt: 0 } } } },
      include: { inventory: { where: { partId, quantity: { gt: 0 } } } },
    });
    const checkedOut = checkedOutBins.sort(compareBinsInShelfOrder)[0] ?? null;

    if (typeof args.destinationBinCode === "string") {
      const requested = await prisma.bin.findUnique({
        where: { code: args.destinationBinCode.toUpperCase() },
        include: { inventory: { where: { quantity: { gt: 0 } } } },
      });
      const before = requested?.inventory.reduce((sum, row) => sum + row.quantity, 0) ?? 0;
      return {
        source: checkedOut || requested?.status === "CHECKED_OUT" ? "OUTPUT" : "INTAKE",
        destination: args.destinationBinCode,
        capacity: requested
          ? {
              before,
              after: requested.status === "CHECKED_OUT" ? quantity : before + quantity,
              limit: requested.capacity,
            }
          : null,
      };
    }
    if (checkedOut && quantity <= checkedOut.capacity) {
      const before = checkedOut.inventory.reduce((sum, row) => sum + row.quantity, 0);
      return {
        source: "OUTPUT",
        destination: checkedOut.code,
        capacity: { before, after: quantity, limit: checkedOut.capacity },
      };
    }
    const destinations = await listPutawayDestinations(partId, quantity);
    const chosen = checkedOut
      ? destinations.find(
          (candidate) =>
            candidate.eligible &&
            candidate.status === "AVAILABLE" &&
            candidate.currentQuantity === 0,
        )
      : destinations.find((candidate) => candidate.eligible && candidate.alreadyStoresPart) ??
        destinations.find((candidate) => candidate.eligible);
    return chosen
      ? {
          source: checkedOut ? "OUTPUT" : "INTAKE",
          destination: chosen.code,
          capacity: {
            before: chosen.currentQuantity,
            after: chosen.afterQuantity,
            limit: chosen.capacity,
          },
        }
      : { source: "INTAKE", destination: "(no compatible bin)", capacity: null };
  };

  // A confirmed human identity wins: for an ambiguous scan the matcher has no
  // single answer, and a card reading "PUTAWAY of this part" tells the
  // operator nothing about what they are approving.
  if (catalogResolutionId) {
    const resolution = await getCatalogResolution(catalogResolutionId);
    if (resolution?.status === "CONFIRMED" && resolution.selectedPartId) {
      const part = await prisma.part.findUnique({ where: { id: resolution.selectedPartId } });
      if (part) {
        const route = await putawayRoute(part.id, scanResult?.quantity?.observed ?? 1);
        return {
          action: "PUTAWAY",
          sku: part.sku,
          canonicalName: part.canonicalName,
          ...route,
          quantity: scanResult?.quantity?.observed ?? 1,
          scope: "COUNTED_UNITS",
        };
      }
    }
  }

  if (scanResult) {
    try {
      const match = await matchScanToCatalog(scanResult);
      if (match.status === "MATCHED") {
        sku = match.matchedPart.sku;
        canonicalName = match.matchedPart.canonicalName;
        resolvedPartId = match.matchedPart.id;
      }
    } catch {
      // A card without a name is still safe; the service revalidates anyway.
    }
  }

  const route = resolvedPartId
    ? await putawayRoute(resolvedPartId, scanResult?.quantity?.observed ?? 1)
    : { source: "INTAKE", destination: "(chosen at execution)", capacity: null };
  return {
    action: "PUTAWAY",
    sku,
    canonicalName,
    ...route,
    quantity: scanResult?.quantity?.observed ?? 1,
    scope: "COUNTED_UNITS",
  };
}

async function parkForApproval(input: {
  agent: Agent;
  interruptId: string;
  interruptReason: unknown;
  requestId: string;
  scanResult: ScanResult | null;
  scanImageDataUrl: string | null;
  catalogResolutionId: string | null;
  traceId: string | null;
  /** The chat this pause belongs to, so the resumed turn updates its memory. */
  sessionId: string | null;
}): Promise<PendingApprovalView> {
  const call = parseInterruptReason(input.interruptReason);
  const toolName = call?.name ?? "unknown_tool";
  const summary = await summarizeToolCall(
    toolName,
    call?.input,
    input.scanResult,
    input.catalogResolutionId,
  );

  // JSON round-trip: the snapshot is stored as plain data, never as a live
  // object graph holding model or credential references.
  const snapshot = JSON.parse(
    JSON.stringify(input.agent.takeSnapshot({ preset: "session" })),
  ) as Snapshot;

  return createPendingApproval({
    interruptId: input.interruptId,
    toolName,
    toolInput: call?.input ?? null,
    summary,
    snapshot,
    requestId: input.requestId,
    scanResult: input.scanResult,
    scanImageDataUrl: input.scanImageDataUrl,
    catalogResolutionId: input.catalogResolutionId,
    traceId: input.traceId,
    sessionId: input.sessionId,
  });
}

/** Fixed operator-facing text for a cancelled action. Never model output. */
export const DENIED_REPLY =
  "Cancelled. The operation was not approved, so nothing was moved and no warehouse state changed. Ask again if you want to start a new request.";

export type ResumeResult =
  | { ok: true; reply: WarehouseAgentReply }
  | { ok: false; reason: "approval_not_found" | "approval_expired" | "approval_not_pending"; message: string };

/**
 * Applies an operator decision to the exact interrupted tool call.
 *
 * The client supplies only an approval id and APPROVE/DENY. It cannot restate
 * the tool arguments: those were frozen when the interrupt was parked, so an
 * approval for "B2-01" can never be turned into "B1-02" on the way back. Changing
 * the action requires a new tool call and a new approval.
 *
 * The original requestId is restored with the scan, so approving twice cannot
 * execute the underlying operation twice — the M7/M8 idempotency keys still do
 * their job on the resumed run.
 */
export async function resumeWarehouseAgent(
  approvalId: unknown,
  decision: ApprovalDecision,
  /** Test seam: build the agent with a scripted model instead of Bedrock. */
  createAgent: () => Agent = createWarehouseAgent,
): Promise<ResumeResult> {
  if (typeof approvalId !== "string" || approvalId.trim() === "") {
    throw new AgentError("agent_invalid_request", ["approvalId must be a non-empty string"]);
  }

  const claim = await claimApproval(approvalId.trim());
  if (!claim.ok) {
    const message =
      claim.reason === "approval_expired"
        ? "This approval has expired and the action was not performed. Ask again to start a new one."
        : claim.reason === "approval_not_pending"
          ? `This approval was already ${claim.status?.toLowerCase()}. Start a new request to act again.`
          : "That approval does not exist.";

    // Reported on the ORIGINAL trace, recovered from the persisted audit row —
    // the in-process entry that held it is already gone. An expired approval is
    // the end of that timeline, and no mutation events follow it.
    if (claim.reason === "approval_expired") {
      await recordEvent(claim.traceId, {
        type: "APPROVAL_EXPIRED",
        status: "FAILED",
        name: approvalId.trim(),
        summary: "The approval expired before a decision was made. Nothing was performed.",
        completedAt: new Date(),
        metadata: { approvalId: approvalId.trim() },
      });
      await completeTrace(claim.traceId, { status: "EXPIRED" });
    }
    return { ok: false, reason: claim.reason, message };
  }

  const parked = claim.approval;

  const traceId = parked.traceId;
  // The moment the operator decided. Recorded now rather than after the resumed
  // run, so the timeline reads in the order things actually happened: the
  // decision precedes the tool it authorised.
  const decidedAt = new Date();
  const humanDecisionDurationMs = decidedAt.getTime() - claim.createdAt.getTime();

  await recordEvent(traceId, {
    type: decision === "APPROVE" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
    status: decision === "APPROVE" ? "COMPLETED" : "BLOCKED",
    name: parked.toolName,
    summary:
      decision === "APPROVE"
        ? "Operator approved the action."
        : "Operator denied the action. Nothing was moved.",
    completedAt: decidedAt,
    // How long the system waited for a person — not model latency.
    durationMs: humanDecisionDurationMs,
    metadata: { approvalId: approvalId.trim(), tool: parked.toolName },
  });

  if (decision === "DENY") {
    // Settle first: the tool must not be reachable even if resume misbehaves.
    await settleApproval(approvalId.trim(), "DENIED");
  }

  const agent = createAgent();
  // The parked snapshot ALREADY contains the whole conversation: the agent it
  // was taken from had this session's history loaded before it ran. So there is
  // nothing extra to restore here, and restoring anything would fight it.
  agent.loadSnapshot(parked.snapshot);
  const marker = conversationMarker(agent);

  // Same bag as the original invocation's, for the same two reasons: the hooks
  // read the trace id out of it, and they record a tool failure into it.
  const invocationState: Record<string, unknown> = { [TRACE_ID_STATE_KEY]: traceId };

  try {
    const { result, workflows } = await runWithRequestContext(
      {
        scanResult: parked.scanResult,
        scanImageDataUrl: parked.scanImageDataUrl,
        requestId: parked.requestId,
        catalogResolutionId: parked.catalogResolutionId,
        workflowSessionId: parked.sessionId,
        // The SAME trace as the interrupted request. Clicking APPROVE
        // continues one timeline; it does not begin a second one.
        traceId,
      },
      async () => {
        const invocation = await agent.invoke(
          [
            new InterruptResponseContent({
              interruptId: parked.interruptId,
              // The HITL handler's default evaluator approves on `true`.
              response: decision === "APPROVE",
            }),
          ],
          { invocationState },
        );
        return { result: invocation, workflows: getContextWorkflows() };
      },
    );

    // The persisted settlement still happens here, exactly as in Milestone 9:
    // the decision is only durable once the resumed run has been driven.
    if (decision === "APPROVE") await settleApproval(approvalId.trim(), "APPROVED");

    // Only what the resumed run added — the parked snapshot's own history is
    // the operator's earlier turns, already reported when they happened.
    const toolCalls = extractToolCalls(messagesSince(agent, marker));
    // The decision closed the exchange the pause opened, so THIS is the state
    // the session should remember: the tool ran (or was refused) and the model
    // answered. A run that stopped on another interrupt is skipped and handled
    // by the approval it just raised, which carries the same session id on.
    persistConversation(parked.sessionId, agent, result.stopReason);

    // The model asked again. After a DENIAL that is exactly the harassment the
    // operator just refused, so no new approval is created: the interrupt is
    // abandoned, nothing executes, and the answer stays "cancelled". Only an
    // explicit new request from the operator may open another approval.
    if (decision === "DENY" && result.stopReason === "interrupt") {
      console.log(`[warehouse-agent] suppressed re-request after denial approval=${approvalId}`);
      await completeTrace(traceId, { status: "DENIED", metrics: traceMetricsFrom(result) });
      return {
        ok: true,
        reply: {
          status: "COMPLETED",
          message: DENIED_REPLY,
          agent: WAREHOUSE_AGENT_NAME,
          model: getBedrockModelId(),
          toolCalls,
          traceId: traceId ?? "",
        },
      };
    }

    // After an approval the model may legitimately need a further action.
    // Nothing has executed; park it rather than pretending the turn finished.
    if (result.stopReason === "interrupt" && result.interrupts?.length) {
      const approval = await parkForApproval({
        agent,
        interruptId: result.interrupts[0].id,
        interruptReason: result.interrupts[0].reason,
        requestId: parked.requestId,
        scanResult: parked.scanResult,
        scanImageDataUrl: parked.scanImageDataUrl,
        catalogResolutionId: parked.catalogResolutionId,
        traceId,
        sessionId: parked.sessionId,
      });
      await recordEvent(traceId, {
        type: "APPROVAL_REQUIRED",
        status: "BLOCKED",
        name: approval.action,
        summary: `${approval.summary.action} of ${approval.summary.sku ?? "an unidentified part"} is waiting for operator approval.`,
        metadata: { approvalId: approval.approvalId, tool: approval.action },
      });
      await setTraceStatus(traceId, "WAITING_FOR_APPROVAL");
      return {
        ok: true,
        reply: {
          status: "APPROVAL_REQUIRED",
          message: approvalPrompt(approval.summary),
          agent: WAREHOUSE_AGENT_NAME,
          model: getBedrockModelId(),
          toolCalls,
          traceId: traceId ?? "",
          approval,
          ...(workflows.length > 0 ? { workflows } : {}),
        },
      };
    }

    const visible = extractVisibleText(result.lastMessage);

    console.log(
      `[warehouse-agent] resumed approval=${approvalId} decision=${decision} stopReason=${result.stopReason} tools=${toolCalls.join(",") || "none"}`,
    );

    const status: TraceStatus =
      decision === "DENY"
        ? "DENIED"
        : terminalStatusFor(workflows, failedToolNames(invocationState));
    await recordEvent(traceId, {
      type: "AGENT_COMPLETED",
      status: status === "COMPLETED" ? "COMPLETED" : "BLOCKED",
      name: WAREHOUSE_AGENT_NAME,
      summary: `Request ${status.toLowerCase()}.`,
      completedAt: new Date(),
      metadata: { tools: toolCalls, status },
    });
    await completeTrace(traceId, { status, metrics: traceMetricsFrom(result) });

    return {
      ok: true,
      reply: {
        status: "COMPLETED",
        // After a denial the model's own wording is discarded. Live runs had it
        // reply "Please approve the retrieval" and "confirm if you still want
        // to proceed" — asking again for what the operator had just refused.
        // Prompt rules did not hold reliably, and nothing the model can add
        // after a cancellation is worth that risk, so the sentence is fixed.
        message:
          decision === "DENY"
            ? DENIED_REPLY
            : visible || EMPTY_REPLY_FALLBACK,
        agent: WAREHOUSE_AGENT_NAME,
        model: getBedrockModelId(),
        toolCalls,
        traceId: traceId ?? "",
        // Empty after a denial: the graph never ran, so there is nothing to show.
        ...(workflows.length > 0 ? { workflows } : {}),
      },
    };
  } catch (err) {
    console.error("[warehouse-agent] resume failed:", err);
    const classified = classifyAgentFailure(err);
    await recordEvent(traceId, {
      type: "AGENT_FAILED",
      status: "FAILED",
      name: WAREHOUSE_AGENT_NAME,
      summary: classified.message,
      completedAt: new Date(),
      metadata: { code: classified.code },
    });
    await completeTrace(traceId, {
      status: "FAILED",
      error: { code: classified.code, message: sanitizeError(classified).message },
    });
    throw classified;
  }
}
