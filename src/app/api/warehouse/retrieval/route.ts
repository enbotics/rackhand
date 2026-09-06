import { NextResponse } from "next/server";
import { executeRetrieval } from "@/lib/warehouse/retrieval-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";

/**
 * POST /api/warehouse/retrieval — { sku | partId, sourceBinCode?, requestId? }
 *
 * The deterministic retrieval path, with no LLM in it — the counterpart to
 * /api/warehouse/putaway. It calls the same function execute_retrieval calls,
 * so there is no duplicated business logic and no second validation path.
 *
 * A refused retrieval is a 200 carrying `{ ok: false, reason }`: "we have none
 * of those" is a normal warehouse answer and the caller needs the structured
 * reason. Only a malformed request is a 4xx.
 *
 * requestId is the caller's idempotency key. Supplying a stable one makes a
 * retry safe; the service generates one otherwise, which keeps the call valid
 * but means a repeat would fetch a second item.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPTIONAL_STRINGS = ["sku", "partId", "sourceBinCode", "requestId"] as const;

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);

    const issues = OPTIONAL_STRINGS.filter(
      (field) => body[field] !== undefined && typeof body[field] !== "string",
    ).map((field) => `${field} must be a string when present`);
    if (issues.length > 0) {
      throw new WarehouseError("validation_failed", "Invalid retrieval request.", issues);
    }

    const result = await executeRetrieval({
      sku: body.sku as string | undefined,
      partId: body.partId as string | undefined,
      sourceBinCode: body.sourceBinCode as string | undefined,
      requestId: body.requestId as string | undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
