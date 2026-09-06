import { NextResponse } from "next/server";
import { getTrace } from "@/lib/observability/trace-service";
import { warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * GET /api/observability/traces/[id] — one trace with its ordered timeline.
 *
 * READ ONLY, AND ONLY GET, for the same reason as the list endpoint: nothing
 * in the observability surface may cause a warehouse action.
 *
 * What comes back has already been sanitized on the way IN (see
 * observability/sanitize.ts), so no raw Strands object, prompt, credential or
 * image can be here to leak. Events are ordered by their stored sequence, not
 * by database row order.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const trace = await getTrace(id);
    if (!trace) {
      throw new WarehouseError("validation_failed", `No trace "${id}".`);
    }
    return NextResponse.json(trace);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
