/**
 * Classifies whether a newly-created catalog Part is "returnable" — the kind
 * of item an operator checks out and puts back for the next person (a shared
 * hand tool: screwdriver, wrench, hex key) rather than one that gets used up
 * or installed by whoever takes it (small hardware, fasteners, single-use
 * items). Purely a semantic judgment on the part's name/category/description
 * — no image, no warehouse state — so this runs on Bedrock (warehouse
 * reasoning), never Gemini (vision only, see model.ts's own header comment).
 *
 * A LEAF CALL, not a repository concern: repository.createPart never invokes
 * this itself, so every existing test/script that creates a Part stays
 * exactly as fast and offline as before. Only the real end-to-end path
 * (POST /api/warehouse/parts) calls this and passes the result in.
 *
 * FAILS CLOSED: any error, timeout, or unparseable answer returns `false` —
 * the schema's own default — rather than throwing. A part creation must never
 * fail because a classification call had a bad day.
 */
import { Message, TextBlock } from "@strands-agents/sdk";
import type { BaseModelConfig, Model } from "@strands-agents/sdk";
import { createWarehouseModel } from "./model";

export interface ReturnabilityInput {
  canonicalName: string;
  category?: string | null;
  description?: string | null;
}

const SYSTEM_PROMPT =
  "You classify warehouse catalog parts. Answer with exactly one word: " +
  "TRUE or FALSE. No punctuation, no explanation.";

function buildPrompt(input: ReturnabilityInput): string {
  const lines = [
    `Name: ${input.canonicalName}`,
    input.category ? `Category: ${input.category}` : null,
    input.description ? `Description: ${input.description}` : null,
  ].filter((line): line is string => line !== null);

  return (
    "Is this part \"returnable\"? A returnable part is a shared tool an " +
    "operator checks out to do a job and is expected to put back for the " +
    "next person — e.g. a screwdriver, wrench, hex key, or other reusable " +
    "hand tool. A NON-returnable part is consumed, installed, or otherwise " +
    "used up by whoever takes it — e.g. a bolt, screw, bearing, or other " +
    "small hardware/fastener that leaves the shared pool once taken.\n\n" +
    `${lines.join("\n")}\n\n` +
    "Answer with exactly one word: TRUE or FALSE."
  );
}

/** Strict on purpose: anything that isn't an unambiguous TRUE/FALSE answer is treated as unparseable. */
function parseAnswer(text: string): boolean | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === "TRUE") return true;
  if (normalized === "FALSE") return false;
  return null;
}

/**
 * `model` is a test seam — pass a scripted Model to unit-test this without a
 * live Bedrock call, matching invokeWarehouseAgent's `createAgent` seam.
 * Nothing in production passes it.
 */
export async function classifyReturnable(
  input: ReturnabilityInput,
  model: Model<BaseModelConfig> = createWarehouseModel(),
): Promise<boolean> {
  try {
    const message = new Message({ role: "user", content: [new TextBlock(buildPrompt(input))] });
    // streamAggregated is an async generator, not a plain Promise — the final
    // StreamAggregatedResult only arrives as the generator's RETURN value
    // once it's fully drained. Same idiom the SDK's own summarize.js uses for
    // a single-shot (non-agentic, no tools) model call.
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

    const answer = parseAnswer(text);
    if (answer === null) {
      console.error(`[returnability] unparseable model answer, defaulting to false: ${JSON.stringify(text)}`);
      return false;
    }
    return answer;
  } catch (err) {
    console.error("[returnability] classification failed, defaulting to false:", err);
    return false;
  }
}
