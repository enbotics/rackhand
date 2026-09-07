import { describe, expect, it } from "vitest";
import {
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type BaseModelConfig,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { classifyReturnable } from "@/lib/agents/returnability-classifier";

/**
 * Same ScriptedModel idiom as tests/warehouse-agent-loop.test.ts: implement
 * only the abstract `stream()`, and the inherited `streamAggregated()` (which
 * classifyReturnable actually calls) aggregates it for free — no network, no
 * Bedrock credentials needed.
 */
class ScriptedModel extends Model<BaseModelConfig> {
  constructor(private readonly events: ModelStreamEvent[]) {
    super();
  }

  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return {} as BaseModelConfig;
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    for (const event of this.events) yield event;
  }
}

/** A model whose single call throws — proves classifyReturnable fails closed. */
class ThrowingModel extends Model<BaseModelConfig> {
  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return {} as BaseModelConfig;
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error("simulated model failure");
  }
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

const SCREWDRIVER = { canonicalName: "Phillips Screwdriver", category: "hand tool" };
const BOLT = { canonicalName: "M8 x 50 Hex Bolt", category: "fastener" };

describe("classifyReturnable", () => {
  it("returns true for an unambiguous TRUE answer", async () => {
    const model = new ScriptedModel(textTurn("TRUE"));
    expect(await classifyReturnable(SCREWDRIVER, model)).toBe(true);
  });

  it("returns false for an unambiguous FALSE answer", async () => {
    const model = new ScriptedModel(textTurn("FALSE"));
    expect(await classifyReturnable(BOLT, model)).toBe(false);
  });

  it("is lenient about surrounding whitespace and case", async () => {
    const model = new ScriptedModel(textTurn("  true  \n"));
    expect(await classifyReturnable(SCREWDRIVER, model)).toBe(true);
  });

  it("fails closed to false on an unparseable answer", async () => {
    const model = new ScriptedModel(textTurn("Sure, this is definitely returnable!"));
    expect(await classifyReturnable(SCREWDRIVER, model)).toBe(false);
  });

  it("fails closed to false on empty output", async () => {
    const model = new ScriptedModel([
      new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" }),
      new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "endTurn" }),
    ]);
    expect(await classifyReturnable(SCREWDRIVER, model)).toBe(false);
  });

  it("fails closed to false when the model throws", async () => {
    expect(await classifyReturnable(SCREWDRIVER, new ThrowingModel())).toBe(false);
  });
});
