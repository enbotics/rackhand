import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Same-origin proxy for the Pi's LAN-only MJPEG stream. */
export async function GET(request: Request) {
  if (!warehouseSessionIdFromRequest(request)) {
    return new Response("A valid warehouse session is required.", { status: 400 });
  }
  const configured = process.env.CAMERA_STREAM_URL?.trim()
    || "http://warehouse-pi.local:8000/stream.mjpg";
  let streamUrl: URL;
  try {
    streamUrl = new URL(configured);
    if (!['http:', 'https:'].includes(streamUrl.protocol)) throw new Error("invalid protocol");
  } catch {
    return new Response("CAMERA_STREAM_URL is invalid.", { status: 500 });
  }

  try {
    const upstream = await fetch(streamUrl, {
      cache: "no-store",
      headers: { Accept: "multipart/x-mixed-replace" },
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("Raspberry Pi live preview is unavailable.", { status: 503 });
    }
    return new Response(upstream.body, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Content-Type": upstream.headers.get("content-type")
          ?? "multipart/x-mixed-replace; boundary=FRAME",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return new Response("Raspberry Pi live preview is unavailable.", { status: 503 });
  }
}
