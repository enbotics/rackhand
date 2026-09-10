import { NextResponse } from "next/server";
import { pendingAuditCapture } from "@/lib/warehouse/audit-bin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only poll used by the already-open Warehouse Command Center camera. */
export async function GET() {
  return NextResponse.json(await pendingAuditCapture());
}
