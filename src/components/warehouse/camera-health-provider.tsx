"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { CameraDeviceHealthView } from "@/lib/camera/device-health-types";
import { warehouseBrowserSessionId } from "@/lib/warehouse/browser-session";
import { WAREHOUSE_SESSION_QUERY } from "@/lib/warehouse/workflow-session";

interface CameraHealthContextValue {
  health: CameraDeviceHealthView | null;
  streamError: string | null;
}

const CameraHealthContext = createContext<CameraHealthContextValue | null>(null);

export function CameraHealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<CameraDeviceHealthView | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(
      `/api/camera/health/events?${WAREHOUSE_SESSION_QUERY}=${encodeURIComponent(warehouseBrowserSessionId())}`,
    );
    const onHealth = (event: Event) => {
      try {
        setHealth(JSON.parse((event as MessageEvent<string>).data) as CameraDeviceHealthView);
        setStreamError(null);
      } catch {
        setStreamError("The camera health stream returned invalid data.");
      }
    };
    const onStreamError = (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
        setStreamError(data.message ?? "Camera health stream failed.");
      } catch {
        setStreamError("Camera health stream failed.");
      }
    };
    source.addEventListener("health", onHealth);
    source.addEventListener("stream-error", onStreamError);
    return () => {
      source.removeEventListener("health", onHealth);
      source.removeEventListener("stream-error", onStreamError);
      source.close();
    };
  }, []);

  return (
    <CameraHealthContext.Provider value={{ health, streamError }}>
      {children}
    </CameraHealthContext.Provider>
  );
}

export function useCameraHealth(): CameraHealthContextValue {
  const value = useContext(CameraHealthContext);
  if (!value) {
    throw new Error("useCameraHealth must be used inside CameraHealthProvider.");
  }
  return value;
}
