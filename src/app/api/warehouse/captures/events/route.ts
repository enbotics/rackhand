import { randomUUID } from "node:crypto";
import { CAMERA_SSE_HEADERS, sseEvent, sseHeartbeat } from "@/lib/camera/sse";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";
import { prisma } from "@/lib/warehouse/db";
import { pendingPutawayCapture } from "@/lib/warehouse/putaway-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function pendingCapture() {
  const [putaway, audit] = await Promise.all([
    pendingPutawayCapture(),
    prisma.auditCaptureRequest.findFirst({
      where: { status: "WAITING_FOR_CAMERA" },
      orderBy: { createdAt: "asc" },
      include: { binAudit: { include: { bin: true } } },
    }),
  ]);
  if (putaway.captureId) return { ...putaway, purpose: "PUTAWAY" as const };
  if (audit) {
    return {
      captureId: audit.id,
      binCode: audit.binAudit.bin.code,
      purpose: "AUDIT" as const,
    };
  }
  return { captureId: null };
}

/** Pushes newly requested putaway/audit captures to the shared popup. */
export function GET(request: Request) {
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
            const capture = await pendingCapture();
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
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void pushCurrent();
        });

      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(sseHeartbeat());
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
