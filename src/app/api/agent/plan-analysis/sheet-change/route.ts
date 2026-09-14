import { NextResponse } from "next/server";
import { automaticPlansEnabled, recordEngineeringPlanChange } from "@/lib/engineering-plan/auto-coordinator";
import { validSheetEvent, validSheetSignature } from "@/lib/engineering-plan/sheet-events";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.ENGINEERING_PLAN_WEBHOOK_SECRET ?? "";
  const spreadsheetId = process.env.ENGINEERING_PLAN_SPREADSHEET_ID?.trim() ?? "";
  if (!automaticPlansEnabled() || secret.length < 32 || !spreadsheetId)
    return NextResponse.json({ error: "automatic_plan_trigger_not_configured" }, { status: 503 });
  // Bound the actual streamed body, not merely an untrusted Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "invalid_sheet_event" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 2_048) {
      await reader.cancel();
      return NextResponse.json({ error: "sheet_event_too_large" }, { status: 413 });
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!validSheetSignature(body, request.headers.get("x-rackhand-signature"), secret))
    return NextResponse.json({ error: "invalid_sheet_signature" }, { status: 401 });
  let event: unknown;
  try { event = JSON.parse(body); } catch { return NextResponse.json({ error: "invalid_sheet_event" }, { status: 400 }); }
  if (!validSheetEvent(event, spreadsheetId))
    return NextResponse.json({ error: "invalid_or_stale_sheet_event" }, { status: 400 });
  await recordEngineeringPlanChange(event.spreadsheetId, event.occurredAt);
  return NextResponse.json({ queued: true }, { status: 202 });
}
