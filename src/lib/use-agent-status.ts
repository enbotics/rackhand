"use client";

import { useEffect, useRef, useState } from "react";
import { WAREHOUSE_SESSION_QUERY } from "@/lib/warehouse/workflow-session";
import { warehouseBrowserSessionId } from "@/lib/warehouse/browser-session";

/**
 * Fast enough to feel live without hammering the server — the same instinct
 * behind gantry's own 250ms active-poll rate, for the same reason: this only
 * ever polls while something is genuinely in flight.
 */
const AGENT_STATUS_POLL_MS = 300;

export interface AgentStatusState {
  /** The real tool the agent is running right now, or null. Never a guess — see live-status-store.ts. */
  liveToolName: string | null;
}

/**
 * Polls /api/agent/status ONLY while `active` (the caller's agentBusy) is
 * true — unlike the materials-plan/overview pollers, there is nothing to
 * report and nothing worth asking about once a turn has already finished, so
 * this holds no idle poll at all rather than slowing down.
 */
export function useLiveToolStatus(active: boolean): AgentStatusState {
  const [liveToolName, setLiveToolName] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      // Nothing running (or the turn just ended) — never show a stale label
      // held over from the last time something was.
      setLiveToolName(null);
      return;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const sessionId = warehouseBrowserSessionId();
        const response = await fetch(
          `/api/agent/status?${WAREHOUSE_SESSION_QUERY}=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        if (response.ok) {
          const data = (await response.json()) as { toolName: string | null };
          if (mounted.current && !stopped) setLiveToolName(data.toolName);
        }
      } catch {
        // A missed poll just means the label stays as it was for one tick —
        // this is a supplementary indicator, not the operator's only signal
        // that something is happening.
      }
      if (!stopped) timer = setTimeout(tick, AGENT_STATUS_POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active]);

  return { liveToolName };
}
