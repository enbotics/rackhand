import { NextResponse } from "next/server";
import { decideRetrievalCapture } from "@/lib/warehouse/retrieval-verification";
import type { RetrievalCaptureDecision } from "@/lib/warehouse/retrieval-capture-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Body is not valid JSON." } }, { status: 400 });
  }
  const decision = (body as { decision?: unknown } | null)?.decision;
  if (decision !== "ACCEPT" && decision !== "RETRY" && decision !== "CANCEL") {
    return NextResponse.json({ error: { message: "Decision must be ACCEPT, RETRY or CANCEL." } }, { status: 422 });
  }
  try {
    return NextResponse.json(await decideRetrievalCapture(id, decision as RetrievalCaptureDecision));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const message = reason.startsWith("This ") || reason.startsWith("The retrieval ")
      ? reason
      : "The retrieval verification decision could not be applied.";
    return NextResponse.json({
      error: { message },
    }, { status: 409 });
  }
}
