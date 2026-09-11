import { NextResponse } from "next/server";
import { getLiveToolStatus } from "@/lib/agents/live-status-store";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

/**
 * GET /api/agent/status — the real tool name the agent is running RIGHT NOW
 * for this browser session's in-flight turn, if any.
 *
 * WHY THIS EXISTS. POST /api/agent is one blocking request: the browser
 * learns nothing about what happened until the whole turn (possibly several
 * chained tool calls) finishes. The busy indicator used to GUESS what was
 * probably happening from the operator's own message text, client-side,
 * before the server had done anything — a guess with no connection to
 * reality. This is polled instead, the same way gantry/materials-plan
 * progress already are, so the label is a fact written the instant the SDK's
 * BeforeToolCallEvent actually fires (see warehouse-agent.ts), not a guess.
 *
 * Session-scoped like materials-plan/latest: two operators' in-flight turns
 * must never leak into each other's busy indicator.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) {
    return NextResponse.json({ toolName: null });
  }
  const status = getLiveToolStatus(sessionId);
  return NextResponse.json({ toolName: status?.toolName ?? null });
}
