"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MaterialsPlanCheckView } from "@/lib/warehouse/dashboard-types";
import { WAREHOUSE_SESSION_QUERY } from "@/lib/warehouse/workflow-session";
import { warehouseBrowserSessionId } from "@/lib/warehouse/browser-session";

/** Mirrors useWarehouseOverview's self-scheduling setTimeout pattern exactly. */
const MATERIALS_PLAN_ACTIVE_POLL_MS = 1_000;
const MATERIALS_PLAN_IDLE_POLL_MS = 20_000;

export interface MaterialsPlanState {
  materialsPlanCheck: MaterialsPlanCheckView | null;
}

/** This session's latest legacy build-plan stock check, retained for history. */
export function usePendingMaterialsPlan(): MaterialsPlanState {
  const [materialsPlanCheck, setMaterialsPlanCheck] = useState<MaterialsPlanCheckView | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Returns the fetched value directly (not just via state) so `tick` can
  // decide the next poll interval from fresh data without a stale closure
  // over React state set earlier in the same render cycle.
  const refresh = useCallback(async (): Promise<MaterialsPlanCheckView | null> => {
    try {
      const sessionId = warehouseBrowserSessionId();
      const response = await fetch(
        `/api/warehouse/materials-plan/latest?${WAREHOUSE_SESSION_QUERY}=${encodeURIComponent(sessionId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { materialsPlanCheck: MaterialsPlanCheckView | null };
      if (mounted.current) setMaterialsPlanCheck(data.materialsPlanCheck);
      return data.materialsPlanCheck;
    } catch {
      // The last known check stays on screen; this is a supplementary poll,
      // not the operator's only view of what happened.
      return null;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const latest = await refresh();
      if (!stopped) {
        const delay = latest?.status === "RUNNING"
          ? MATERIALS_PLAN_ACTIVE_POLL_MS
          : MATERIALS_PLAN_IDLE_POLL_MS;
        timer = setTimeout(tick, delay);
      }
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  return { materialsPlanCheck };
}
