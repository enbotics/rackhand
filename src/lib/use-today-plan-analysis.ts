"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TodayPlanAnalysisRunView } from "@/lib/engineering-plan/analysis-types";
import { WAREHOUSE_SESSION_HEADER } from "@/lib/warehouse/workflow-session";
import { warehouseBrowserSessionId } from "@/lib/warehouse/browser-session";

const ACTIVE_REFRESH_MS = 2_000;
const IDLE_REFRESH_MS = 20_000;

function active(run: TodayPlanAnalysisRunView | null): boolean {
  return run?.status === "QUEUED" || run?.status === "RUNNING";
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/** Durable, browser-session-scoped view of tomorrow's RackHand plan analysis. */
export function useTodayPlanAnalysis() {
  const [run, setRun] = useState<TodayPlanAnalysisRunView | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<TodayPlanAnalysisRunView | null> => {
    try {
      const sessionId = warehouseBrowserSessionId();
      const response = await fetch("/api/agent/plan-analysis", {
        cache: "no-store",
        headers: { [WAREHOUSE_SESSION_HEADER]: sessionId },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { run: TodayPlanAnalysisRunView | null };
      if (mounted.current) setRun(payload.run);
      return payload.run;
    } catch {
      return null;
    }
  }, []);

  const trigger = useCallback(async (): Promise<boolean> => {
    if (triggering) return false;
    setTriggering(true);
    setError(null);
    try {
      const sessionId = warehouseBrowserSessionId();
      const response = await fetch("/api/agent/plan-analysis", {
        method: "POST",
        headers: { [WAREHOUSE_SESSION_HEADER]: sessionId },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        run?: TodayPlanAnalysisRunView | null;
        error?: unknown;
      };
      if (!response.ok) {
        if (mounted.current) {
          setError(errorMessage(payload, "RackHand could not start tomorrow’s plan analysis."));
        }
        return false;
      }
      if (mounted.current && payload.run) setRun(payload.run);
      return true;
    } catch {
      if (mounted.current) setError("RackHand could not be reached. Try again.");
      return false;
    } finally {
      if (mounted.current) setTriggering(false);
    }
  }, [triggering]);

  // NO realtime EventSource here, deliberately — see the removed one's git
  // history if reviving this. Every open tab already holds one permanent
  // EventSource for Pi-camera capture events (audit-capture-dialog.tsx,
  // load-bearing, never remove), and `next dev` serves plain HTTP/1.1, which
  // caps the BROWSER (not the server) at 6 simultaneous connections to one
  // origin, shared across every tab. A second always-on stream here was
  // confirmed live to blow that budget with as few as two tabs open: closing
  // just the /trig tab that held it immediately un-froze the OTHER tab's own
  // chat, which had been silently queued waiting for a connection slot the
  // capture stream and this one were hogging forever. The 2s/20s poll below
  // is the only update path now — plenty fast for a manually-triggered,
  // background analysis, and it costs one short-lived request instead of a
  // connection held open for the tab's entire lifetime.

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const latest = await refresh();
      if (!stopped) {
        timer = setTimeout(tick, active(latest) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
      }
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  return { run, triggering, error, trigger, refresh };
}
