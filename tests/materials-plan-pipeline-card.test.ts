import { describe, expect, it } from "vitest";
import { materialsJobProgress } from "@/components/warehouse/materials-plan-pipeline-card";
import type { ApprovalOutcome, PendingApprovalView } from "@/components/warehouse/state";

const approval = (
  action: "MATERIALS_FULFILLMENT" | "RETRIEVAL" | "PUTAWAY",
  queue?: string[],
): PendingApprovalView => ({
  approvalId: `approval-${action}`,
  action: action.toLowerCase(),
  expiresAt: "2026-09-13T12:00:00.000Z",
  summary: {
    action,
    sku: null,
    canonicalName: null,
    source: null,
    destination: action === "PUTAWAY" ? "B3-03" : "OUTPUT",
    quantity: 1,
    ...(queue ? { fulfillmentQueue: queue, fulfillmentTotal: 3 } : {}),
  },
});

describe("materials plan pipeline progress", () => {
  it("starts at the first bin while initial approval is pending", () => {
    expect(materialsJobProgress(3, approval("MATERIALS_FULFILLMENT"), null)).toEqual({
      activeIndex: 0,
      completedCount: 0,
      stage: "FULFILL",
      complete: false,
      started: false,
    });
  });

  it("shows verification of the first returned bin", () => {
    expect(materialsJobProgress(3, approval("PUTAWAY", ["B3-03", "B6-03"]), null))
      .toMatchObject({ activeIndex: 0, completedCount: 0, stage: "VERIFY" });
  });

  it("advances to the second bin after the first return", () => {
    expect(materialsJobProgress(3, approval("RETRIEVAL", ["B6-03"]), null))
      .toMatchObject({ activeIndex: 1, completedCount: 1, stage: "FULFILL" });
  });

  it("finishes only after the final photo return settles", () => {
    const finalApproval = approval("PUTAWAY", []);
    const outcome: ApprovalOutcome = {
      kind: "SETTLED",
      summary: finalApproval.summary,
      message: "Returned.",
    };
    expect(materialsJobProgress(3, null, outcome, {
      workflow: "PUTAWAY",
      operationId: "putaway-final",
      status: "COMPLETED",
      steps: [],
      movementId: "movement-final",
      gantryOperationId: "gantry-final",
    })).toEqual({
      activeIndex: 2,
      completedCount: 3,
      stage: "RESULT",
      complete: true,
      started: true,
    });
  });
});
