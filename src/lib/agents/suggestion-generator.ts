/**
 * Turns real, precomputed SuggestionFacts (see suggestion-facts.ts) into
 * short, natural-sounding chat suggestions — a LEAF CALL, same shape as
 * returnability-classifier.ts: single-shot, no tools, no warehouse access of
 * its own, fails closed to an empty list rather than throwing.
 *
 * THE ONLY JOB HERE IS PHRASING. Every concrete detail (bin code, part name,
 * quantity, hour count) already came from the database before this file ever
 * runs; the prompt forbids introducing a bin code, SKU, name or number that
 * isn't already present in the fact it's phrasing. This is the same
 * "resolve truth in code, let the model only supply surface language"
 * pattern used throughout warehouse-agent.ts (resolvePartQuery before
 * forcing execute_retrieval, the forced putaway-offer) — applied here
 * because a suggestion is free-text that gets typed into the composer, never
 * something that itself moves a bin.
 */
import { Message, TextBlock } from "@strands-agents/sdk";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { createWarehouseModel } from "./model";
import type { SuggestionFact } from "./suggestion-facts";

const SYSTEM_PROMPT = `You write short chat suggestions for the operator of a warehouse app to send to "RackHand", their warehouse agent.

You will be given a numbered list of FACTS, each already true and already verified. For each fact, write exactly one short suggestion (under 90 characters) phrased as something the operator would naturally type — first person or a direct request. Keep every bin code, part name, quantity and number from the fact EXACTLY as written. Never invent, guess, or add any bin code, SKU, part name, or number that is not already present in that fact.

Reply with ONLY a JSON array of strings, one per fact, in the same order, no markdown, no code fences, no commentary.`;

function factLine(fact: SuggestionFact): string {
  switch (fact.type) {
    case "fetchable_item":
      return `Bin ${fact.binCode} is occupied and holds ${fact.quantity} of "${fact.partName}", which could be fetched right now.`;
    case "available_capacity":
      return `${fact.availableBins} bin${fact.availableBins === 1 ? " is" : "s are"} currently available to store a new part.`;
    case "audit_due":
      return fact.reason === "never_run"
        ? "No inventory audit has ever been run in this workspace."
        : `The last completed inventory audit finished about ${fact.hoursSinceLastAudit} hours ago.`;
    case "build_plan_capability":
      return "RackHand can plan the materials for any build the operator describes, even without knowing the exact parts up front.";
  }
}

function buildPrompt(facts: SuggestionFact[]): string {
  return facts.map((fact, index) => `${index + 1}. ${factLine(fact)}`).join("\n");
}

/** Strips a ```json fence if the model added one despite the instruction not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

const MAX_SUGGESTION_LENGTH = 140;

function parseSuggestions(text: string, expectedCount: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const suggestions = parsed
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim().slice(0, MAX_SUGGESTION_LENGTH))
    .slice(0, expectedCount);
  return suggestions.length > 0 ? suggestions : null;
}

/**
 * `model` is a test seam, matching classifyReturnable's own. Nothing in
 * production passes it.
 */
export async function generateSuggestions(
  facts: SuggestionFact[],
  model: Model<BaseModelConfig> = createWarehouseModel(),
): Promise<string[]> {
  if (facts.length === 0) return [];
  try {
    const message = new Message({ role: "user", content: [new TextBlock(buildPrompt(facts))] });
    const stream = model.streamAggregated([message], { systemPrompt: SYSTEM_PROMPT });
    let result: IteratorResult<unknown, { message: Message }>;
    for (;;) {
      result = await stream.next();
      if (result.done) break;
    }

    const text = result.value.message.content
      .filter((block): block is TextBlock => block instanceof TextBlock)
      .map((block) => block.text)
      .join("");

    const suggestions = parseSuggestions(text, facts.length);
    if (suggestions === null) {
      console.error(`[suggestions] unparseable model output, returning none: ${JSON.stringify(text)}`);
      return [];
    }
    return suggestions;
  } catch (err) {
    console.error("[suggestions] generation failed, returning none:", err);
    return [];
  }
}
