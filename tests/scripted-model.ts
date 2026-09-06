import {
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

/**
 * A model whose turns are scripted, so the agent loop runs with no network.
 *
 * This proves WIRING — agent loop, interventions, tool dispatch, services —
 * not that a real LLM chooses the right tool. That is what `npm run
 * agent:smoke` is for.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
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
export function toolUseTurn(name: string, toolUseId: string, input = "{}"): ModelStreamEvent[] {
  return [
    new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" }),
    new ModelContentBlockStartEvent({
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", name, toolUseId },
    }),
    new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input },
    }),
    new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" }),
    new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "toolUse" }),
  ];
}

export function textTurn(text: string): ModelStreamEvent[] {
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
