import { NextResponse } from "next/server";
import { invokeWarehouseAgent } from "@/lib/agents/warehouse-agent";
import { createRequestId } from "@/lib/agents/request-context";
import { AgentError, classifyAgentFailure } from "@/lib/agents/errors";

/**
 * POST /api/agent — { "message": "...", "scanResult"?: ScanResult, "sessionId"?: string }
 *
 * Runs one Warehouse Agent turn server-side, so no model credentials ever reach
 * the browser. The response carries the assistant's visible answer plus an
 * operational trace of which tools were called — never private reasoning.
 *
 * The optional scanResult is the browser's Milestone 1 output, for the
 * match_catalog tool. It is validated separately from the message and handed
 * to the agent out-of-band (see lib/agents/request-context.ts) rather than being
 * pasted into the conversation: a client may supply scan DATA, never
 * conversation structure, tool-call blocks or message history.
 *
 * The optional sessionId does not weaken that rule. It is an opaque handle,
 * validated as a key and used only to look up a conversation this server wrote
 * itself (lib/agents/conversation-store.ts). The browser selects which of its
 * own past turns to continue; it never gets to say what happened in them, so it
 * still cannot hand the model a tool result that never occurred.
 *
 * Thin by design: validation, invocation and error classification all live in
 * lib/agents/.
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

    const { message, scanResult, scanImageDataUrl, catalogResolutionId, sessionId } = body as {
      message?: unknown;
      scanResult?: unknown;
      scanImageDataUrl?: unknown;
      catalogResolutionId?: unknown;
      sessionId?: unknown;
    };
    if (catalogResolutionId !== undefined && typeof catalogResolutionId !== "string") {
      throw new AgentError("agent_invalid_request", [
        "catalogResolutionId must be a string when present",
      ]);
    }
    if (
      scanImageDataUrl !== undefined &&
      (typeof scanImageDataUrl !== "string" ||
        !/^data:image\/[a-z0-9.+-]+;base64,/i.test(scanImageDataUrl) ||
        scanImageDataUrl.length > 7_000_000)
    ) {
      throw new AgentError("agent_invalid_request", [
        "scanImageDataUrl must be a base64 image data URL no larger than 7 MB",
      ]);
    }
    // One HTTP request gets one id, which becomes the default idempotency key
    // for any state-changing tool the agent calls — so a model that retries a
    // retrieval inside a single turn fetches one part, not two.
    const reply = await invokeWarehouseAgent(
      message,
      scanResult,
      createRequestId(),
      catalogResolutionId,
      undefined,
      scanImageDataUrl as string | undefined,
      // Shape-checked in lib/agents/conversation-store.ts, alongside the other
      // validators, so one place decides what a valid session handle is.
      sessionId,
    );
    return NextResponse.json(reply);
  } catch (err) {
    // Every path returns a fixed safe message; provider detail stays in the
    // server log, so no stack trace, ARN or credential can reach a client.
    const agentError = classifyAgentFailure(err);
    if (agentError.code !== "agent_invalid_request") {
      console.error("[warehouse-agent] request failed:", agentError.code);
    }
    return NextResponse.json(agentError.toResponseBody(), { status: agentError.status });
  }
}
