"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Idle refresh only — this is a cosmetic empty-state affordance, not
 * something that needs to react within a second the way gantry/agent-status
 * polling does. Long enough that it never competes with anything time
 * sensitive, short enough that a workspace left open on the empty state
 * eventually picks up a bin that was just filled from another session.
 */
const REFRESH_MS = 60 * 1000;

/**
 * Fetches /api/agent/suggestions ONLY while `active` (the caller's own
 * "chat is genuinely empty and idle" condition) is true. Never guesses
 * client-side — every string returned already passed through
 * suggestion-facts.ts's real warehouse snapshot and suggestion-generator.ts's
 * fact-only phrasing constraint.
 */
export function useAgentSuggestions(active: boolean): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setSuggestions([]);
      return;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const response = await fetch("/api/agent/suggestions", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { suggestions: string[] };
          if (mounted.current && !stopped) setSuggestions(data.suggestions);
        }
      } catch {
        // A missed refresh just leaves whatever suggestions were already
        // showing (or none) — nothing else in the chat depends on this.
      }
      if (!stopped) timer = setTimeout(tick, REFRESH_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active]);

  return suggestions;
}
