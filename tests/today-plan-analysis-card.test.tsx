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
    rows: [
      {
        planId: "WO-SA-219",
        project: "Sensor Array",
        buildTask: "Sensor Array",
        priority: "HIGH",
        status: "RELEASED",
      },
    ],
    requirements: [
      {
        sku: "SKU-READY",
        purpose: "Prepare drive wheel",
        category: "hardware",
        quantity: 4,
      },
      {
        sku: "SKU-SHORT",
        purpose: "Prepare Sensor modules",
        category: "sensors",
        quantity: 19,
      },
    ],
    result: {
      readiness: "PARTIALLY_READY",
      message: "Done: 1 of 2 parts is ready. 1 needs another check.",
      selectedBins: [
        {
          sku: "SKU-READY",
          binCode: "B5-03",
          recordedQuantity: 5,
          requiredQuantity: 4,
        },
      ],
      shortages: [{ sku: "SKU-SHORT", required: 19, available: 18 }],
      auditedBinCodes: [],
      verificationAuditRunIds: [],
      auditIssues: [
        {
          sku: "SKU-SHORT",
          binCode: "B4-01",
          expectedQuantity: 20,
          observedQuantity: 18,
          confidencePercent: 100,
          reason: "audit_pending_confirmation",
        },
      ],
      scanSkips: [
        {
          sku: "SKU-READY",
          binCode: "B5-03",
          lastVerifiedAt: "2026-09-05T00:00:00.000Z",
          reason: "latest trusted verification is current",
        },
      ],
    },
    errorMessage: null,
    startedAt: Date.parse("2026-09-12T00:00:00.000Z"),
    completedAt: Date.parse("2026-09-12T01:00:00.000Z"),
    createdAt: Date.parse("2026-09-12T00:00:00.000Z"),
    updatedAt: Date.parse("2026-09-12T01:00:00.000Z"),
    events: [
      {
        id: "event-audit",
        sequence: 1,
        stage: "AUDITING_BIN",
        status: "RUNNING",
        summary:
          "RackHand chose to verify B4-01 for SKU-SHORT. Recorded: 20. Last verified: 7 days ago.",
        createdAt: 1,
      },
    ],
  };
}

describe("upcoming plan analysis report", () => {
  it("separates ready bins from materials that will not be used", () => {
    render(<TodayPlanAnalysisCard run={partialRun()} />);

    expect(screen.getByText("Upcoming work plan")).toBeTruthy();
    expect(screen.getByText("REPORT READY")).toBeTruthy();
    expect(screen.getByText("PARTIALLY READY")).toBeTruthy();
    expect(
      screen.getAllByText("Upcoming Sensor-Array Assembly").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Needs 19 sensor modules")).toBeTruthy();
    expect(screen.getByText("Recorded: 20")).toBeTruthy();
    expect(screen.getByText("Last verified: 7 days ago")).toBeTruthy();
    expect(screen.getByText("RackHand chose to verify this bin")).toBeTruthy();
    expect(screen.getByText("Needs another check · 1")).toBeTruthy();
    expect(
      screen.getByText("Reason: Last verification was 7 days ago."),
    ).toBeTruthy();
    expect(screen.getByText("NEEDS ANOTHER CHECK").className).toContain(
      "text-danger",
    );
    expect(screen.getByText("Physically found: 18")).toBeTruthy();
    expect(screen.getByText(/Stock unchanged/)).toBeTruthy();
    expect(
      screen.getByText(/Bins are checked at the camera, then returned/),
    ).toBeTruthy();
    expect(screen.getByText("Recent checks used · 1")).toBeTruthy();
    expect(screen.getByText("RECENT CHECK USED").className).toContain(
      "text-success",
    );
    expect(
      screen.getByText(/Recorded: 5 · Last verified: 7 days ago/),
    ).toBeTruthy();

    const ready = screen.getByText(/Ready · 1 bin/).parentElement;
    expect(ready).not.toBeNull();
    expect(within(ready!).getByText("drive wheel")).toBeTruthy();

    const notUsed = screen.getByText(/Not ready · 1 part/).parentElement;
    expect(notUsed).not.toBeNull();
    expect(
      within(notUsed!).getByText("Sensor-Array Assembly at risk"),
    ).toBeTruthy();
    expect(within(notUsed!).getByText("Needs 19 · Verified 18")).toBeTruthy();
    expect(
      within(notUsed!).getByText("Short by 1 · Engineer attention needed"),
    ).toBeTruthy();
    expect(within(notUsed!).getByText("NOT READY").className).toContain(
      "text-danger",
    );
  });

  it("shows the corrected verification age for B5-01 without confidence sentences", () => {
    const run = partialRun();
    run.result!.auditIssues[0].binCode = "B5-01";
    run.events[0].summary =
      "RackHand chose to verify B5-01 for SKU-SHORT. Recorded: 19. Last verified: Needs review.";

    const { container } = render(<TodayPlanAnalysisCard run={run} />);

    expect(screen.getByText("Reason: Last verification was 7 days ago.")).toBeTruthy();
    expect(screen.getByText("Last verified: 7 days ago")).toBeTruthy();
    expect(screen.queryByText("Last verified: Needs review")).toBeNull();
    expect(container.textContent).not.toMatch(/confiden/i);
    expect(screen.queryByText("Reason: Previous check was not accepted")).toBeNull();
  });

  it("reports recorded 12, physically found 10, required 11 and short by 1 after a successful check", () => {
    const run = partialRun();
    run.requirements[1].quantity = 11;
    run.events[0].summary =
      "RackHand chose to verify B5-01 for SKU-SHORT. Recorded: 12. Last verified: 7 days ago.";
    run.result!.auditIssues = [];
    run.result!.auditedBinCodes = ["B5-01"];
    run.result!.physicalCounts = [{ sku: "SKU-SHORT", binCode: "B5-01", recordedQuantity: 12,
      observedQuantity: 10, usable: true, inventoryUpdated: false,
      scale: { status: "VERIFIED", totalWeightGrams: 167, estimatedQuantity: 10 } }];
    run.result!.shortages = [{ sku: "SKU-SHORT", required: 11, available: 10, physicallyAvailable: 10 }];

    render(<TodayPlanAnalysisCard run={run} />);
    expect(screen.getByText("B5-01 · Recorded: 12")).toBeTruthy();
    expect(screen.getByText("Physically found: 10")).toBeTruthy();
    expect(screen.getByText("Scale count: 10")).toBeTruthy();
    expect(screen.getByText("Needs 11 · Physically found 10")).toBeTruthy();
    expect(screen.getByText("Short by 1 · Engineer attention needed")).toBeTruthy();
    expect(screen.queryByText(/Verified 0/)).toBeNull();
  });

  it("does not claim a shortage of 11 when the physical count is unresolved", () => {
    const run = partialRun();
    run.result!.shortages = [{ sku: "SKU-SHORT", required: 11, available: 0, physicallyAvailable: null }];
    render(<TodayPlanAnalysisCard run={run} />);
    expect(screen.getByText("Needs 11 · Physically found Needs review")).toBeTruthy();
    expect(screen.getByText("Physical count needs another check")).toBeTruthy();
    expect(screen.queryByText(/Short by 11/)).toBeNull();
  });

  it("keeps the reason for a completed physical check in the first report block", () => {
    const run = partialRun();
    run.result!.auditIssues = [];
    run.result!.auditedBinCodes = ["B4-01"];

    render(<TodayPlanAnalysisCard run={run} />);

    const needsCheck = screen.getByText("Needs another check · 1");
    const recentCheck = screen.getByText("Recent checks used · 1");
    expect(needsCheck.className).toContain("text-danger");
    expect(
      screen.getByText("Reason: Last verification was 7 days ago."),
    ).toBeTruthy();
    expect(screen.getByText("B4-01 · Recorded: 20")).toBeTruthy();
    expect(
      needsCheck.compareDocumentPosition(recentCheck) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shortens older saved progress and hides the data source", () => {
    const run = partialRun();
    run.events = [
      {
        id: "event-1",
        sequence: 1,
        stage: "READING_SHEET",
        status: "RUNNING",
        summary:
          "Reading tomorrow’s enabled work for 2026-09-12 from the Google Sheet.",
        createdAt: 1,
      },
      {
        id: "event-2",
        sequence: 2,
        stage: "AUDITING_BIN",
        status: "RUNNING",
        summary:
          "Retrieving the full bin B4-01 to the checkout scan station for SKU-SHORT because latest audit is DISMISSED. It will return to the same shelf slot after capture.",
        createdAt: 2,
      },
    ];

    render(<TodayPlanAnalysisCard run={run} />);

    expect(
      screen.getByText("Analyzing upcoming work for 2026-09-12."),
    ).toBeTruthy();
    expect(screen.getByText("Last verified: Needs review")).toBeTruthy();
    expect(
      screen.getByText("Reason: Previous check was not accepted"),
    ).toBeTruthy();
    expect(screen.getByText("RackHand chose to verify this bin")).toBeTruthy();
    expect(screen.queryByText(/Google Sheet/)).toBeNull();
  });
});
