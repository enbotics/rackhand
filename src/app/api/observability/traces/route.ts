import { NextResponse } from "next/server";
import { listTraces } from "@/lib/observability/trace-service";
import { intQueryParam, queryParam, warehouseErrorResponse } from "@/lib/warehouse/http";
import { TRACE_STATUSES, type TraceStatus } from "@/lib/observability/types";

/**
 * GET /api/observability/traces?limit=15&status=COMPLETED — recent agent runs,
 * newest first.
 *
 * READ ONLY, AND ONLY GET. There is deliberately no POST, PUT or DELETE here
 * and no "re-run this tool" affordance anywhere in the observability surface.
 * A trace viewer that could replay a tool call would be a way to move a
 * physical part without an approval and without an idempotency key — that is,
 * a hole straight through Milestones 7-11. Reading history is the whole API.
 *
 * The response carries summaries only; events come from the detail endpoint,
 * so the recent-runs list stays cheap enough to poll.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const status = queryParam(request, "status");
    const valid =
      status && (TRACE_STATUSES as readonly string[]).includes(status)
        ? (status as TraceStatus)
        : undefined;

    return NextResponse.json({
      traces: await listTraces({ limit: intQueryParam(request, "limit"), status: valid }),
    });
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
