import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { engineeringPlanFingerprint, validSheetEvent, validSheetSignature } from "@/lib/engineering-plan/sheet-events";
import type { EngineeringPlanContext } from "@/lib/engineering-plan/google-sheets";

const secret = "a-long-random-server-only-secret-for-testing";
const context: EngineeringPlanContext = {
  configured: true, query: "", currentWorkDate: "2026-09-15", matchCount: 1,
  rows: [{ planId: "WO-SA-219-1", workDate: "2026-09-15", engineer: "Team", project: "Sensor Array",
    buildTask: "Sensor Array", dayObjective: "prepare", plannedWork: "sensors", materialHints: "Sensor modules",
    quantityScale: "11 ea", constraints: "no substitutions", priority: "HIGH", status: "RELEASED", lastUpdated: "old" }],
};

describe("signed Sheet change events", () => {
  it("accepts only the signature bound to the exact body", () => {
    const body = JSON.stringify({ spreadsheetId: "sheet", occurredAt: 123 });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(validSheetSignature(body, signature, secret)).toBe(true);
    expect(validSheetSignature(body + " ", signature, secret)).toBe(false);
    expect(validSheetSignature(body, null, secret)).toBe(false);
    expect(validSheetSignature(body, "invalid", secret)).toBe(false);
    expect(validSheetSignature(body, signature, "short")).toBe(false);
  });
  it("rejects wrong Sheets, stale timestamps and future events", () => {
    const now = 1_000_000;
    expect(validSheetEvent({ spreadsheetId: "sheet", occurredAt: now }, "sheet", now)).toBe(true);
    expect(validSheetEvent({ spreadsheetId: "other", occurredAt: now }, "sheet", now)).toBe(false);
    expect(validSheetEvent({ spreadsheetId: "sheet", occurredAt: now - 300_001 }, "sheet", now)).toBe(false);
    expect(validSheetEvent({ spreadsheetId: "sheet", occurredAt: now + 30_001 }, "sheet", now)).toBe(false);
  });
});

describe("actionable tomorrow-plan fingerprint", () => {
  it("does not repeat an analysis just because edit metadata changed", () => {
    expect(engineeringPlanFingerprint(context)).toBe(engineeringPlanFingerprint({ ...context,
      rows: context.rows.map((row) => ({ ...row, lastUpdated: "new" })) }));
  });
  it("detects changes to required quantity and the work date", () => {
    expect(engineeringPlanFingerprint(context)).not.toBe(engineeringPlanFingerprint({ ...context,
      rows: context.rows.map((row) => ({ ...row, quantityScale: "12 ea" })) }));
    expect(engineeringPlanFingerprint(context)).not.toBe(engineeringPlanFingerprint({ ...context,
      currentWorkDate: "2026-09-16" }));
  });
  it("does not treat a row reorder as new requirements", () => {
    const rows = [...context.rows, { ...context.rows[0], planId: "WO-SA-219-2", materialHints: "Bolts" }];
    expect(engineeringPlanFingerprint({ ...context, rows })).toBe(engineeringPlanFingerprint({ ...context, rows: [...rows].reverse() }));
  });
});
