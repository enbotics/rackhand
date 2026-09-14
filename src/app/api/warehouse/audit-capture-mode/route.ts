import { NextResponse } from "next/server";
import {
  getAuditCaptureMode,
  isAuditCaptureMode,
} from "@/lib/warehouse/audit-capture-mode";
import { SIMULATION_ELIGIBLE_BINS, SIMULATION_LOCK_REASON } from "@/lib/warehouse/simulation-policy";
import { isWarehouseSimulationLocked } from "@/lib/warehouse/deployment-mode";

/**
 * Deployment mode is configured server-side, never changed by a browser.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const locked = isWarehouseSimulationLocked();
  const mode = getAuditCaptureMode();
  return NextResponse.json({
    mode,
    locked,
    eligibleBins: mode === "SIMULATION" ? SIMULATION_ELIGIBLE_BINS : [],
    description: locked ? SIMULATION_LOCK_REASON : "Capture mode is configured in the server environment. Prod uses the physical camera and scale.",
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
  if (isWarehouseSimulationLocked() && mode === "PROD") {
    return NextResponse.json(
      { mode: getAuditCaptureMode(), locked: true,
        error: { code: "simulation_mode_locked", message: SIMULATION_LOCK_REASON } },
      { status: 403 },
    );
  }
  if (mode !== getAuditCaptureMode()) {
    return NextResponse.json(
      { error: { code: "capture_mode_env_only", message: "Configure AUDIT_CAPTURE_MODE in .env.local and restart the server." } },
      { status: 403 },
    );
  }
  return GET();
}
