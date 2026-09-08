import fs from "node:fs/promises";
import path from "node:path";

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

  const root =
    process.env.CAMERA_CAPTURE_DIR ??
    path.join(process.cwd(), "data", "camera-captures");

  const filepath = path.join(root, `${safeId}.jpg`);

  try {
    const buffer = await fs.readFile(filepath);

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
