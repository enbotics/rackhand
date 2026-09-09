import { pendingPutawayCapture } from "@/lib/warehouse/putaway-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await pendingPutawayCapture());
}
