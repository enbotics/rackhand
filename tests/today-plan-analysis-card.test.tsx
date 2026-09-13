// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TodayPlanAnalysisCard } from "@/components/warehouse/today-plan-analysis-card";
import type { TodayPlanAnalysisRunView } from "@/lib/engineering-plan/analysis-types";

afterEach(cleanup);

function partialRun(): TodayPlanAnalysisRunView {
  return {
    id: "run-1",
    status: "COMPLETED_WITH_ISSUES",
    stage: "COMPLETE",
    workDate: "2026-09-12",
    rowsFound: 1,
    currentBinCode: null,
    rows: [],
    requirements: [
      { sku: "SKU-READY", purpose: "frame", category: "metal", quantity: 4 },
      { sku: "SKU-SHORT", purpose: "connector", category: "hardware", quantity: 4 },
    ],
    result: {
      readiness: "PARTIALLY_READY",
      message: "Analysis finished: 1 material is ready for operation; 1 will not be used because shelf stock is insufficient.",
      selectedBins: [
        { sku: "SKU-READY", binCode: "B5-03", recordedQuantity: 5, requiredQuantity: 4 },
      ],
      shortages: [{ sku: "SKU-SHORT", required: 4, available: 0 }],
      auditedBinCodes: [],
      verificationAuditRunIds: [],
      auditIssues: [
        {
          binCode: "B4-01",
          expectedQuantity: 10,
          observedQuantity: 5,
          confidencePercent: 100,
          reason: "audit_pending_confirmation",
        },
      ],
      scanSkips: [
        {
          sku: "SKU-READY",
          binCode: "B5-03",
          lastVerifiedAt: "2026-09-12T00:00:00.000Z",
          reason: "latest trusted verification is current",
        },
      ],
    },
    errorMessage: null,
    startedAt: 1,
    completedAt: 2,
    createdAt: 1,
    updatedAt: 2,
    events: [],
  };
}

describe("tomorrow plan analysis report", () => {
  it("separates ready bins from materials that will not be used", () => {
    render(<TodayPlanAnalysisCard run={partialRun()} />);

    expect(screen.getByText("Tomorrow’s build-plan analysis")).toBeTruthy();
    expect(screen.getByText("REPORT READY")).toBeTruthy();
    expect(screen.getByText("PARTIALLY READY")).toBeTruthy();
    expect(screen.getByText("Audit issues · 1")).toBeTruthy();
    expect(screen.getByText(/B4-01 · 10 recorded → 5 observed/)).toBeTruthy();
    expect(screen.getByText(/inventory left unchanged/)).toBeTruthy();
    expect(screen.getByText(/Audit-selected bins move shelf → checkout scan → same shelf slot/)).toBeTruthy();
    expect(screen.getByText("Smart skips · 1 scan saved")).toBeTruthy();
    expect(screen.getAllByText("B5-03 · SKU-READY")).toHaveLength(2);
    expect(screen.getByText(/trusted verification reused; no inventory change since/)).toBeTruthy();

    const ready = screen.getByText(/Ready for operation/).parentElement;
    expect(ready).not.toBeNull();
    expect(within(ready!).getByText("B5-03 · SKU-READY")).toBeTruthy();

    const notUsed = screen.getByText(/Not used in this plan/).parentElement;
    expect(notUsed).not.toBeNull();
    expect(within(notUsed!).getByText("SKU-SHORT")).toBeTruthy();
    expect(within(notUsed!).getByText("0 shelf-available · 4 required")).toBeTruthy();
  });
});
