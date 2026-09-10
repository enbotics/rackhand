import { randomUUID } from "node:crypto";
import {
  CameraCaptureJobError,
  expireStaleCaptureJobs,
  getCaptureJobStatus,
  isTerminalCaptureStatus,
} from "@/lib/camera/capture-job-service";
import { CAMERA_SSE_HEADERS, sseEvent, sseHeartbeat } from "@/lib/camera/sse";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function publicView(job: Awaited<ReturnType<typeof getCaptureJobStatus>>) {
  return { ...job, captureJobId: job.id, id: undefined };
}

/** Pushes one job's authoritative status; the browser performs no polling. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const ownerSessionId = warehouseSessionIdFromRequest(request);
  if (!ownerSessionId) {
    return Response.json(
      { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
      { status: 400 },
    );
  }
  const sessionId = ownerSessionId;
  try {
    await getCaptureJobStatus(id, sessionId);
  } catch (error) {
    if (error instanceof CameraCaptureJobError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.code === "camera_job_not_found"
            ? 404
            : error.code === "camera_job_not_owned"
              ? 403
              : 409,
        },
      );
    }
    throw error;
  }

  const supabase = createRealtimeAdminClient();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pushing = false;
      let pushAgain = false;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;

      const channel = supabase
        .channel(`camera-job-${id}-${randomUUID()}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "CameraCaptureJob",
          },
          (payload) => {
            if ((payload.new as { id?: string }).id === id) void pushCurrent();
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void pushCurrent();
          if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) && !closed) {
            stop(true);
          }
        });

      const stop = (closeController = false) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (expiryTimer) clearTimeout(expiryTimer);
        void supabase.removeChannel(channel);
        if (closeController) controller.close();
      };
      cleanup = stop;

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
            await expireStaleCaptureJobs();
            const job = await getCaptureJobStatus(id, sessionId);
            if (closed) return;
            controller.enqueue(sseEvent("status", publicView(job)));
            if (expiryTimer) clearTimeout(expiryTimer);
            if (isTerminalCaptureStatus(job.status)) {
              stop(true);
              return;
            }
            if (job.expiresAt) {
              const delay = Math.max(0, new Date(job.expiresAt).getTime() - Date.now() + 100);
              expiryTimer = setTimeout(() => void pushCurrent(), delay);
            }
          } while (pushAgain && !closed);
        } catch (error) {
          if (!closed) {
            controller.enqueue(sseEvent("stream-error", {
              message: error instanceof Error ? error.message : "Camera status stream failed.",
            }));
          }
        } finally {
          pushing = false;
        }
      }

      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(sseHeartbeat());
          // A missed Realtime UPDATE must not leave the browser waiting after
          // the durable camera job has already reached a terminal state.
          void pushCurrent();
        }
      }, 15_000);
      request.signal.addEventListener("abort", () => stop(false), { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, { headers: CAMERA_SSE_HEADERS });
}
