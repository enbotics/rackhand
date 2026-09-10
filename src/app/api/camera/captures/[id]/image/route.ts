import { readCameraCapture } from "@/lib/camera/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ id: string }>;
  },
) {
  const { id } = await context.params;

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");

  if (!safeId || safeId !== id) {
    return new Response("Invalid id", {
      status: 400,
    });
  }

  try {
    const buffer = await readCameraCapture(safeId);

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("Not found", {
      status: 404,
    });
  }
}
