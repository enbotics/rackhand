import { randomUUID } from "node:crypto";
import { authenticateCameraDevice } from "@/lib/camera/device-auth";
import { CAMERA_SSE_HEADERS, sseEvent, sseHeartbeat } from "@/lib/camera/sse";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Realtime wake-up stream. The Pi still claims the durable DB job over HTTP. */
export async function GET(request: Request) {
  const auth = authenticateCameraDevice(request);
  if (!auth.ok) {
    return Response.json(
      { error: { code: "camera_unauthorized", message: "Invalid camera credentials." } },
      { status: 401 },
    );
  }

  const supabase = createRealtimeAdminClient();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        void supabase.removeChannel(channel);
      };
      cleanup = close;

      const wake = () => {
        if (!closed) controller.enqueue(sseEvent("camera-job", { deviceId: auth.deviceId }));
      };
      const channel = supabase
        .channel(`camera-device-${auth.deviceId}-${randomUUID()}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "CameraCaptureJob",
          },
          (payload) => {
            // Avoid a fragile Realtime filter on Prisma's quoted camelCase
            // column. Filtering remains server-side and leaks no job data.
            if ((payload.new as { deviceId?: string }).deviceId === auth.deviceId) wake();
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "CameraCaptureJob",
          },
          (payload) => {
            // Only a recovered lease returning to PENDING requires another
            // device wake. Upload/processing updates are browser concerns.
            const row = payload.new as { deviceId?: string; status?: string };
            if (row.deviceId === auth.deviceId && row.status === "PENDING") wake();
          },
        )
        .subscribe((status) => {
          // Every successful connect performs one durable catch-up. Realtime
          // is only a wake-up signal, so a missed event never loses a job.
          if (status === "SUBSCRIBED") wake();
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) && !closed) {
            close();
            controller.close();
          }
        });

      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(sseHeartbeat());
          // Explicit periodic queue poll. Supabase Realtime is the low-latency
          // path, but delivery of one notification is never a correctness
          // requirement for a durable job.
          wake();
        }
      }, 15_000);

      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, { headers: CAMERA_SSE_HEADERS });
}
