import { randomUUID } from "node:crypto";
import {
  configuredCameraDeviceId,
  getCameraDeviceHealth,
} from "@/lib/camera/device-health-service";
import { CAMERA_SSE_HEADERS, sseEvent, sseHeartbeat } from "@/lib/camera/sse";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function GET(request: Request) {
  if (!warehouseSessionIdFromRequest(request)) {
    return Response.json(
      { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
      { status: 400 },
    );
  }
  const deviceId = configuredCameraDeviceId();
  const supabase = createRealtimeAdminClient();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pushing = false;
      const pushCurrent = async () => {
        if (closed || pushing) return;
        pushing = true;
        try {
          const health = await getCameraDeviceHealth(deviceId);
          if (!closed) controller.enqueue(sseEvent("health", health));
        } catch (error) {
          if (!closed) {
            controller.enqueue(sseEvent("stream-error", {
              message: error instanceof Error ? error.message : "Camera health stream failed.",
            }));
          }
        } finally {
          pushing = false;
        }
      };
      const channel = supabase
        .channel(`camera-health-${deviceId}-${randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "CameraDeviceHealth" },
          (payload) => {
            if ((payload.new as { deviceId?: string }).deviceId === deviceId) {
              void pushCurrent();
            }
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void pushCurrent();
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) && !closed) {
            stop(true);
          }
        });
      const timer = setInterval(() => {
        if (!closed) {
          controller.enqueue(sseHeartbeat());
          // Recompute age-based OFFLINE even when a dead worker cannot emit a
          // final database event.
          void pushCurrent();
        }
      }, 10_000);
      const stop = (closeController = false) => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        void supabase.removeChannel(channel);
        if (closeController) controller.close();
      };
      cleanup = () => stop(false);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, { headers: CAMERA_SSE_HEADERS });
}
