import { randomUUID } from "node:crypto";
import { getLatestWorkflowCaptureJobStatus } from "@/lib/camera/capture-job-service";
import { CAMERA_SSE_HEADERS, sseEvent, sseHeartbeat } from "@/lib/camera/sse";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";
import { pendingAuditCapture } from "@/lib/warehouse/audit-bin-service";
import { pendingPutawayCapture } from "@/lib/warehouse/putaway-verification";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function pendingCapture(ownerSessionId: string) {
  const [putaway, audit] = await Promise.all([
    pendingPutawayCapture(ownerSessionId),
    pendingAuditCapture(ownerSessionId),
  ]);
  const capture = putaway.captureId
    ? { ...putaway, purpose: "PUTAWAY" as const }
    : audit.captureId
      ? audit
      : null;
  if (capture?.captureId) {
    const job = await getLatestWorkflowCaptureJobStatus(capture.captureId, ownerSessionId);
    return {
      ...capture,
      cameraJob: job ? { ...job, captureJobId: job.id, id: undefined } : null,
    };
  }
  return { captureId: null };
}

/** Pushes newly requested putaway/audit captures to the shared popup. */
export function GET(request: Request) {
  const ownerSessionId = warehouseSessionIdFromRequest(request);
  if (!ownerSessionId) {
    return Response.json(
      { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
      { status: 400 },
    );
  }
  const sessionId = ownerSessionId;
  const supabase = createRealtimeAdminClient();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pushing = false;
      let pushAgain = false;

      async function pushCurrent() {
        if (closed) return;
        if (pushing) {
          pushAgain = true;
          return;
        }
        pushing = true;
        try {
          do {
            pushAgain = false;
            const capture = await pendingCapture(sessionId);
            if (!closed) controller.enqueue(sseEvent("pending", capture));
          } while (pushAgain && !closed);
        } catch (error) {
          if (!closed) {
            controller.enqueue(sseEvent("stream-error", {
              message: error instanceof Error ? error.message : "Capture stream failed.",
            }));
          }
        } finally {
          pushing = false;
        }
      }

      const channel = supabase
        .channel(`warehouse-captures-${randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "PutawayCaptureRequest" },
          () => void pushCurrent(),
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "AuditCaptureRequest" },
          () => void pushCurrent(),
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "CameraCaptureJob" },
          (payload) => {
            if ((payload.new as { ownerSessionId?: string }).ownerSessionId === sessionId) {
              void pushCurrent();
            }
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void pushCurrent();
        });

      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(sseHeartbeat());
          // Re-read durable state as well as keeping the connection alive.
          // Supabase Realtime improves latency, but correctness must not
          // depend on every postgres_changes notification arriving.
          void pushCurrent();
        }
      }, 15_000);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        void supabase.removeChannel(channel);
      };
      cleanup = stop;
      request.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, { headers: CAMERA_SSE_HEADERS });
}
