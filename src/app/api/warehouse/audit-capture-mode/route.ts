import { NextResponse } from "next/server";
import {
  getAuditCaptureMode,
  isAuditCaptureMode,
} from "@/lib/warehouse/audit-capture-mode";
import { SIMULATION_ELIGIBLE_BINS, SIMULATION_LOCK_REASON } from "@/lib/warehouse/simulation-policy";

/**
 * Simulation is locked server-side. POST remains compatible with Simulation
 * clients, but cannot activate physical hardware through Prod mode.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    mode: getAuditCaptureMode(),
    locked: true,
    eligibleBins: SIMULATION_ELIGIBLE_BINS,
    description: SIMULATION_LOCK_REASON,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "malformed_request", message: "Body is not valid JSON." } },
      { status: 400 },
    );
  }
  const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
  if (!isAuditCaptureMode(mode)) {
    return NextResponse.json(
      { error: { code: "validation_failed", message: 'mode must be "PROD" or "SIMULATION".' } },
      { status: 422 },
    );
  }
  if (mode === "PROD") {
    return NextResponse.json(
      { mode: getAuditCaptureMode(), locked: true,
        error: { code: "simulation_mode_locked", message: SIMULATION_LOCK_REASON } },
      { status: 403 },
    );
  }
  return GET();
}
