import { NextResponse } from "next/server";
import { loadSuggestionFacts } from "@/lib/agents/suggestion-facts";
import { generateSuggestions } from "@/lib/agents/suggestion-generator";
import { fingerprintFacts, getCachedSuggestions, setCachedSuggestions } from "@/lib/agents/suggestions-cache";

/**
 * GET /api/agent/suggestions — a few chat suggestions for the empty-chat
 * state, grounded in real current warehouse facts (see suggestion-facts.ts)
 * and phrased by a single leaf model call (see suggestion-generator.ts).
 *
 * Global, not session-scoped — the underlying facts are shared warehouse
 * state, not anything specific to one operator's conversation.
 *
 * Fails closed to an empty list on any error: this is a cosmetic empty-state
 * affordance, never something the rest of the chat depends on.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const facts = await loadSuggestionFacts();
    const fingerprint = fingerprintFacts(facts);

    const cached = getCachedSuggestions(fingerprint);
    if (cached) return NextResponse.json({ suggestions: cached });

    const suggestions = await generateSuggestions(facts);
    setCachedSuggestions(fingerprint, suggestions);
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("[agent/suggestions] failed, returning none:", err);
    return NextResponse.json({ suggestions: [] });
  }
}
