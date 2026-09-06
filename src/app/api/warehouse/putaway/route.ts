import { NextResponse } from "next/server";
import { executePutaway } from "@/lib/warehouse/putaway-service";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { WarehouseError } from "@/lib/warehouse/errors";
import { collectScanResultIssues } from "@/lib/warehouse/scan-result";
import type { ScanResult } from "@/lib/warehouse/scan-types";

/**
 * POST /api/warehouse/putaway — { scanResult, destinationBinCode? }
 *
 * The deterministic putaway path, with no LLM anywhere in it. Strands must not
 * be the only way to exercise a warehouse operation: this endpoint makes the
 * service testable by hand and by script, and it calls the same function the
 * execute_putaway tool calls — no duplicated business logic, no second
 * validation path.
 *
 * A refused putaway is a 200 carrying `{ ok: false, reason }`, not an HTTP
 * error: "that bin is occupied" is a normal warehouse answer and the caller
 * needs the structured reason. Only a malformed request is a 4xx.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);

    const issues = collectScanResultIssues(body.scanResult);
    if (issues.length > 0) {
      throw new WarehouseError("validation_failed", "Invalid scanResult.", issues);
    }

    const destination = body.destinationBinCode;
    if (destination !== undefined && typeof destination !== "string") {
      throw new WarehouseError("validation_failed", "Invalid destinationBinCode.", [
        "destinationBinCode must be a string when present",
      ]);
    }

    const result = await executePutaway({
      scanResult: body.scanResult as ScanResult,
      ...(destination === undefined ? {} : { destinationBinCode: destination }),
    });

    return NextResponse.json(result);
  } catch (err) {
    return warehouseErrorResponse(err);
  }
}
