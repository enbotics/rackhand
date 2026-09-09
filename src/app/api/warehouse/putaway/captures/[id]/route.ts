import { NextResponse } from "next/server";
import { verifyPutawayCapture } from "@/lib/warehouse/putaway-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await verifyPutawayCapture(id, await request.json()));
  } catch {
    return NextResponse.json({ error: { message: "The photo could not be analyzed. Remove obstructions if needed and retry with a clear view." } }, { status: 422 });
  }
}
