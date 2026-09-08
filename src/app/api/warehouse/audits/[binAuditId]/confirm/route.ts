import { NextResponse } from "next/server";
import {
  confirmBinAuditObservation,
  type ConfirmBinAuditDecision,
} from "@/lib/warehouse/audit-bin-service";
import { warehouseErrorResponse } from "@/lib/warehouse/http";

/**
 * POST /api/warehouse/audits/[binAuditId]/confirm — { decision: "APPLY" | "DISMISS" }
 *
 * A human's decision on a REVIEW_REQUIRED audit observation. Direct action,
 * no agent/LLM involvement: applying or dismissing a count a person can
 * already see on screen is a plain decision, not something to interpret.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_REASON_STATUS: Record<string, number> = {
  bin_audit_not_found: 404,
  bin_audit_not_pending_confirmation: 409,
  bin_audit_not_confirmable: 422,
};

export async function POST(request: Request, context: { params: Promise<{ binAuditId: string }> }) {
  const { binAuditId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "malformed_request", message: "Body is not valid JSON." } },
      { status: 400 },
    );
  }
  const decision = (body as { decision?: unknown }).decision;
  if (decision !== "APPLY" && decision !== "DISMISS") {
    return NextResponse.json(
      { error: { code: "validation_failed", message: "decision must be \"APPLY\" or \"DISMISS\"." } },
      { status: 422 },
    );
  }

  try {
    const result = await confirmBinAuditObservation(binAuditId, decision as ConfirmBinAuditDecision);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof Error) {
      const [reason] = err.message.split(":");
      const status = KNOWN_REASON_STATUS[reason];
      if (status) {
        return NextResponse.json({ error: { code: reason, message: err.message } }, { status });
      }
    }
    return warehouseErrorResponse(err);
  }
}
