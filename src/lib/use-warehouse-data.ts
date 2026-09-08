"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WarehouseOverview } from "@/lib/warehouse/dashboard-types";
import type { GantryStatus } from "@/lib/gantry/types";
import { isTerminalTraceStatus, type TraceSummaryView, type TraceView } from "@/lib/observability/types";

/**
 * Client data access for the command centre (Milestone 10).
 *
 * Two hooks, two independent failure domains, on purpose: a gantry fault must
 * not blank the inventory panel, and a database hiccup must not hide the
 * machine state. Neither hook holds warehouse logic — each fetches a
 * server-composed view and hands it over unchanged.
 *
 * No data-fetching library. Two polled reads and a refresh-after-mutation do
 * not justify one, and the repo already uses this self-scheduling `setTimeout`
 * pattern for the gantry.
 */

/** Slow safety net. Real freshness comes from refresh() after a mutation. */
const OVERVIEW_IDLE_POLL_MS = 20_000;
const OVERVIEW_ACTIVE_POLL_MS = 1_000;
/** Only while something is actually moving. */
const GANTRY_ACTIVE_POLL_MS = 800;
const GANTRY_IDLE_POLL_MS = 5_000;

export interface OverviewState {
  overview: WarehouseOverview | null;
  /** True only for the very first load, so a refresh never blanks the panels. */
  loading: boolean;
  error: string | null;
  /** Re-reads the authoritative snapshot and returns it, or null if it failed. */
  refresh: () => Promise<WarehouseOverview | null>;
}

export function useWarehouseOverview(active = false): OverviewState {
  const [overview, setOverview] = useState<WarehouseOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<WarehouseOverview | null> => {
    try {
      const response = await fetch("/api/warehouse/overview", { cache: "no-store" });
      if (!response.ok) throw new Error("overview request failed");
      const data = (await response.json()) as WarehouseOverview;
      if (mounted.current) {
        setOverview(data);
        setError(null);
      }
      return data;
    } catch {
      // The last known snapshot stays on screen with the error beside it —
      // blanking the panel would tell the operator the warehouse is empty.
      if (mounted.current) setError("Unable to load warehouse state.");
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped) {
        timer = setTimeout(tick, active ? OVERVIEW_ACTIVE_POLL_MS : OVERVIEW_IDLE_POLL_MS);
      }
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, refresh]);

  return { overview, loading, error, refresh };
}

export interface GantryState {
  status: GantryStatus | null;
  error: string | null;
}

/**
 * Polls the machine. `active` is set by the dashboard while an approved action
 * is in flight, so the state machine is visible during a move without polling
 * at that rate for the rest of the session.
 */
export function useGantryStatus(active: boolean): GantryState {
  const [status, setStatus] = useState<GantryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      let busy = active;
      try {
        const response = await fetch("/api/gantry/status", { cache: "no-store" });
        if (!response.ok) throw new Error("gantry status failed");
        const next = (await response.json()) as GantryStatus;
        if (!stopped) {
          setStatus(next);
          setError(null);
        }
        busy = busy || next.state !== "IDLE";
      } catch {
        if (!stopped) setError("Gantry status unavailable.");
      }
      if (!stopped) {
        timer = setTimeout(tick, busy ? GANTRY_ACTIVE_POLL_MS : GANTRY_IDLE_POLL_MS);
      }
    };

    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active]);

  return { status, error };
}

/* ------------------------------------------------------ observability */

/** Only while something is actually in flight. See `useAgentTrace`. */
const TRACE_ACTIVE_POLL_MS = 800;

export interface AgentTraceState {
  trace: TraceView | null;
  error: string | null;
}

/**
 * Follows one agent trace (Milestone 12).
 *
 * Polls ONLY while the trace is RUNNING or WAITING_FOR_APPROVAL, and stops the
 * moment it reaches a terminal status — an idle dashboard makes no requests at
 * all. A trace waiting for approval keeps polling on purpose: that is exactly
 * the window in which an operator on another screen may decide.
 */
export function useAgentTrace(traceId: string | null): AgentTraceState {
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!traceId) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const response = await fetch(`/api/observability/traces/${traceId}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("trace request failed");
        const next = (await response.json()) as TraceView;
        if (stopped) return;
        setTrace(next);
        setError(null);
        // Terminal: stop asking. Nothing more will happen on this trace.
        if (isTerminalTraceStatus(next.status)) return;
      } catch {
        if (!stopped) setError("Unable to load the activity trace.");
      }
      if (!stopped) timer = setTimeout(tick, TRACE_ACTIVE_POLL_MS);
    };

    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [traceId]);

  // Derived rather than cleared in the effect: while a newly selected trace is
  // still loading, the previous one must not linger on screen pretending to be
  // it. Nothing is reset by a side effect.
  const current = traceId && trace?.traceId === traceId ? trace : null;
  return { trace: current, error: traceId ? error : null };
}

export interface RecentTracesState {
  traces: TraceSummaryView[];
  refresh: () => Promise<void>;
}

/** The recent-runs list. Re-read on demand, never polled. */
export function useRecentTraces(limit = 12): RecentTracesState {
  const [traces, setTraces] = useState<TraceSummaryView[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/observability/traces?limit=${limit}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { traces: TraceSummaryView[] };
      setTraces(data.traces ?? []);
    } catch {
      // A missing history list is not worth an error banner.
    }
  }, [limit]);

  // Scheduled rather than called inline, so the first load happens from a
  // callback like every other fetch in this module.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  return { traces, refresh };
}
