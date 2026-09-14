import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EngineeringPlanContext } from "./google-sheets";

export function validSheetSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || secret.length < 32) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** Ignore edit metadata and row order; hash the normalized actionable tomorrow plan. */
export function engineeringPlanFingerprint(context: EngineeringPlanContext): string {
  const rows = context.rows.map(({ lastUpdated: _lastUpdated, ...row }) => row)
    .sort((a, b) => a.planId.localeCompare(b.planId) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({ workDate: context.currentWorkDate, rows })).digest("hex");
}

export function validSheetEvent(value: unknown, spreadsheetId: string, now = Date.now()): value is {
  spreadsheetId: string; occurredAt: number;
} {
  if (!value || typeof value !== "object") return false;
  const event = value as { spreadsheetId?: unknown; occurredAt?: unknown };
  return event.spreadsheetId === spreadsheetId && typeof event.occurredAt === "number"
    && Number.isSafeInteger(event.occurredAt) && event.occurredAt <= now + 30_000
    && event.occurredAt >= now - 300_000;
}
