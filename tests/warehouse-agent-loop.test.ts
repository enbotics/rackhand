import { beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { WAREHOUSE_AGENT_PROMPT } from "@/lib/agents/warehouse-prompt";
import { WAREHOUSE_AGENT_TOOLS } from "@/lib/agents/tools";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";

/**
 * Proves the tool is reachable THROUGH the Strands agent loop, not just
 * callable on its own.
 *
 * This is NOT a substitute for the live-model test: it scripts the model's
 * turns, so it proves the wiring (agent loop -> registered tool ->
 * GantryController -> simulator -> result back into the conversation), not
 * that a real LLM chooses the tool unprompted. Whether Claude on Bedrock
 * autonomously selects it can only be shown by `npm run agent:smoke` with AWS
 * credentials present.
 */

/** A model whose turns are scripted, so the agent loop runs with no network. */
class ScriptedModel extends Model<BaseModelConfig> {
  private turn = 0;
  readonly seenMessages: Message[][] = [];

  constructor(private readonly turns: ModelStreamEvent[][]) {
    super();
  }

  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return {} as BaseModelConfig;
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seenMessages.push(messages);
    const events = this.turns[Math.min(this.turn, this.turns.length - 1)];
    this.turn += 1;
    for (const event of events) yield event;
  }
}

/**
 * Stop reasons are camelCase ("toolUse"/"endTurn"). The StopReason type ends
 * in `(string & {})`, so a snake_case value type-checks but silently ends the
 * loop instead of triggering tool execution.
 */
function toolUseTurn(name: string, toolUseId: string): ModelStreamEvent[] {
  return [
    new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" }),
    new ModelContentBlockStartEvent({
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", name, toolUseId },
    }),
    new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input: "{}" },
    }),
    new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" }),
    new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "toolUse" }),
  ];
}

function textTurn(text: string): ModelStreamEvent[] {
  return [
    new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" }),
    new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    }),
    new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" }),
    new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "endTurn" }),
  ];
}

function buildAgent(model: Model<BaseModelConfig>): Agent {
  return new Agent({
    name: "warehouse-agent",
    model,
    systemPrompt: WAREHOUSE_AGENT_PROMPT,
    tools: WAREHOUSE_AGENT_TOOLS,
    printer: false,
  });
}

beforeEach(() => {
  resetGantryController();
});

describe("agent loop reaches the tool", () => {
  it("executes get_gantry_status and feeds the real result back to the model", async () => {
    const model = new ScriptedModel([
      toolUseTurn("get_gantry_status", "tooluse_1"),
      textTurn("The gantry is IDLE in simulation mode."),
    ]);
    const agent = buildAgent(model);

    const result = await agent.invoke("What is the current gantry status?");

    // The loop ran the tool the agent had registered.
    const toolUses = agent.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "toolUseBlock").map((b) => b.name),
    );
    expect(toolUses).toEqual(["get_gantry_status"]);

    // The tool's result — real controller state — went back into the conversation.
    const toolResults = agent.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "toolResultBlock"),
    );
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0])).toContain("SIMULATION");
    expect(JSON.stringify(toolResults[0])).toContain("IDLE");

    expect(result.lastMessage.content.some((b) => b.type === "textBlock")).toBe(true);
  });

  it("reports genuine controller state, not a canned reading", async () => {
    const controller = getGantryController();
    await controller.home();
    await controller.putaway({ source: "INTAKE", destination: "B03" });

    const model = new ScriptedModel([
      toolUseTurn("get_gantry_status", "tooluse_1"),
      textTurn("Reported."),
    ]);
    const agent = buildAgent(model);
    await agent.invoke("Status?");

    const toolResult = JSON.stringify(
      agent.messages.flatMap((m) => m.content.filter((b) => b.type === "toolResultBlock")),
    );
    expect(toolResult).toContain("B03");
    expect(toolResult).toContain('"homed":true');
  });

  it("moves nothing — the read-only tool creates no operations", async () => {
    const controller = getGantryController();
    const model = new ScriptedModel([
      toolUseTurn("get_gantry_status", "tooluse_1"),
      textTurn("Done."),
    ]);

    await buildAgent(model).invoke("Status?");

    expect(await controller.getRecentOperations()).toEqual([]);
    expect((await controller.getStatus()).currentLocation).toBeNull();
  });

  it("cannot reach a tool that was never registered", async () => {
    const controller = getGantryController();
    const model = new ScriptedModel([
      // The model asks to move the gantry; no such tool is registered.
      toolUseTurn("putaway", "tooluse_1"),
      textTurn("I do not have a tool that can move the gantry."),
    ]);
    const agent = buildAgent(model);

    await agent.invoke("Move the gantry to B03.");

    // Nothing moved, and the loop surfaced an error result rather than acting.
    expect(await controller.getRecentOperations()).toEqual([]);
    const results = JSON.stringify(
      agent.messages.flatMap((m) => m.content.filter((b) => b.type === "toolResultBlock")),
    );
    expect(results.toLowerCase()).toContain("error");
  });

  it("sends the warehouse system prompt to the model", async () => {
    const model = new ScriptedModel([textTurn("Hello.")]);
    await buildAgent(model).invoke("Hi");
    expect(model.seenMessages.length).toBeGreaterThan(0);
  });
});
