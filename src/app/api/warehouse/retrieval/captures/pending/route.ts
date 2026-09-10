import { pendingRetrievalCapture } from "@/lib/warehouse/retrieval-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await pendingRetrievalCapture());
}
