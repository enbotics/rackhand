import { NextResponse } from "next/server";
import {
  getAuditCaptureMode,
  isAuditCaptureMode,
  setAuditCaptureMode,
} from "@/lib/warehouse/audit-capture-mode";

/**
 * GET  /api/warehouse/audit-capture-mode — { mode: "PROD" | "SIMULATION" }
 * POST /api/warehouse/audit-capture-mode — { mode } sets it for the rest of this running process
 *
 * A live alternative to editing AUDIT_CAPTURE_MODE in .env and restarting
 * the server — see lib/warehouse/audit-capture-mode.ts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ mode: getAuditCaptureMode() });
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
  const mode = (body as { mode?: unknown }).mode;
  if (!isAuditCaptureMode(mode)) {
    return NextResponse.json(
      { error: { code: "validation_failed", message: 'mode must be "PROD" or "SIMULATION".' } },
      { status: 422 },
    );
  }
  setAuditCaptureMode(mode);
  return NextResponse.json({ mode });
}
