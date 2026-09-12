/**
 * Process-local cache for generated chat suggestions (see suggestion-facts.ts
 * and suggestion-generator.ts), keyed by a fingerprint of the FACTS rather
 * than by session — the underlying facts are global warehouse state, not
 * anything specific to one operator's conversation, so every idle browser
 * sharing the same facts should share one cached phrasing rather than each
 * triggering its own Bedrock call.
 *
 * Invalidates itself the instant the facts actually change (a different
 * fingerprint), and additionally expires after TTL_MS so a long-idle empty
 * chat still refreshes occasionally even if nothing else changed. Same
 * ephemeral, presentation-only caveat as live-status-store.ts: fine to lose
 * on a redeploy, never a source of warehouse truth.
 */
import type { SuggestionFact } from "./suggestion-facts";

interface CachedSuggestions {
  fingerprint: string;
  suggestions: string[];
  updatedAt: number;
}

const TTL_MS = 90 * 1000;

const globalForSuggestions = globalThis as unknown as {
  warehouseSuggestionsCache?: CachedSuggestions;
};

export function fingerprintFacts(facts: SuggestionFact[]): string {
  return JSON.stringify(facts);
}

export function getCachedSuggestions(fingerprint: string): string[] | null {
  const cached = globalForSuggestions.warehouseSuggestionsCache;
  if (!cached) return null;
  if (cached.fingerprint !== fingerprint) return null;
  if (Date.now() - cached.updatedAt > TTL_MS) return null;
  return cached.suggestions;
}

export function setCachedSuggestions(fingerprint: string, suggestions: string[]): void {
  globalForSuggestions.warehouseSuggestionsCache = { fingerprint, suggestions, updatedAt: Date.now() };
}
