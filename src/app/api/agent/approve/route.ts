import { NextResponse } from "next/server";
import { resumeWarehouseAgent } from "@/lib/agents/warehouse-agent";
import { AgentError, classifyAgentFailure } from "@/lib/agents/errors";

/**
 * POST /api/agent/approve — { approvalId, decision: "APPROVE" | "DENY" }
 *
 * Applies an operator decision to the exact tool call that was interrupted and
 * resumes the paused Strands run.
 *
 * The body carries ONLY an id and a decision. Tool arguments are deliberately
 * not accepted: they were frozen when the interrupt was parked, so an approval
 * for "B2-01" cannot be edited into "B1-02" on the way back. Changing the action
 * needs a new tool call and a new approval.
 *
 * A React button saying `approved = true` authorises nothing. This route is
 * where authorisation actually happens.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AgentError("agent_invalid_request", ["body is not parseable JSON"]);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AgentError("agent_invalid_request", ["body must be a JSON object"]);
    }

    const { approvalId, decision } = body as { approvalId?: unknown; decision?: unknown };
    if (decision !== "APPROVE" && decision !== "DENY") {
      throw new AgentError("agent_invalid_request", ['decision must be "APPROVE" or "DENY"']);
    }

    const result = await resumeWarehouseAgent(approvalId, decision);
    if (!result.ok) {
      // A refused decision is a normal outcome, not a server fault, but it must
      // never read as success.
      return NextResponse.json(
        { status: result.reason === "approval_expired" ? "APPROVAL_EXPIRED" : "APPROVAL_REJECTED", ...result },
        { status: 409 },
      );
    }

    return NextResponse.json(result.reply);
  } catch (err) {
    const agentError = classifyAgentFailure(err);
    if (agentError.code !== "agent_invalid_request") {
      console.error("[warehouse-agent] approval failed:", agentError.code);
    }
    return NextResponse.json(agentError.toResponseBody(), { status: agentError.status });
  }
}
