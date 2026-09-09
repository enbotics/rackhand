import { NextResponse } from "next/server";
import { decideAuditCapture } from "@/lib/warehouse/audit-bin-service";
import type { AuditCaptureDecision } from "@/lib/warehouse/audit-capture-types";

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
  if (decision !== "ACCEPT" && decision !== "RETRY") {
    return NextResponse.json({ error: { message: "Decision must be ACCEPT or RETRY." } }, { status: 422 });
  }
  try {
    await decideAuditCapture(id, decision as AuditCaptureDecision);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: { message: "This verification is stale or cannot be changed." } }, { status: 409 });
  }
}
