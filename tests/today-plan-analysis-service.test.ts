import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(), claim: vi.fn(), load: vi.fn(), last: vi.fn(), event: vi.fn(),
  prepare: vi.fn(), audit: vi.fn(), physical: vi.fn(), inventory: vi.fn(), evidence: vi.fn(),
  latest: vi.fn(), audits: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/warehouse/db", () => {
  const prisma = {
    engineeringPlanAnalysisRun: { update: mocks.update, updateMany: mocks.claim, findUniqueOrThrow: mocks.load, findFirst: mocks.latest },
    engineeringPlanAnalysisEvent: { findFirst: mocks.last, create: mocks.event },
    binAudit: { findMany: mocks.audits },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(prisma),
  };
  return { prisma };
});
vi.mock("@/lib/engineering-plan/google-sheets", () => ({
  getEngineeringPlanContextForWorkDate: async () => ({ reason: "ready", currentWorkDate: "2026-09-15",
    rows: [{ planId: "plan", project: "Sensor Array", buildTask: "Sensor Array", priority: "HIGH", status: "RELEASED" }] }),
  tomorrowEngineeringPlanWorkDate: () => "2026-09-15",
}));
vi.mock("@/lib/agents/materials-planner-agent", () => ({
  createMaterialsPlannerAgent: () => ({ invoke: async () => ({ structuredOutput: { requirements: [{ sku: "SENSOR", quantity: 11 }] } }) }),
  MATERIALS_PLANNER_OUTPUT: { safeParse: (data: unknown) => ({ success: true, data }) },
}));
vi.mock("@/lib/warehouse/materials-fulfillment-service", () => ({ MAX_MATERIALS_FULFILLMENT_BINS: 20, prepareMaterialsFulfillment: mocks.prepare }));
vi.mock("@/lib/warehouse/inventory-audit-service", () => ({ runInventoryAudit: mocks.audit }));
vi.mock("@/lib/warehouse/inventory-service", () => ({ getInventoryForPart: mocks.inventory }));
vi.mock("@/lib/warehouse/bin-verification-evidence", () => ({ getBinVerificationEvidence: mocks.evidence }));
vi.mock("@/lib/engineering-plan/physical-count-service", () => ({ readPhysicalCount: mocks.physical }));
import { executeTodayPlanAnalysis, getLatestTodayPlanAnalysis } from "@/lib/engineering-plan/analysis-service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.load.mockResolvedValue({ ownerSessionId: "session", workDate: "2026-09-15" });
  mocks.prepare.mockResolvedValueOnce({ ok: false, reason: "materials_verification_required", selectedBins: [],
    requirements: [{ sku: "SENSOR", quantity: 11 }], shortages: [], verificationTargets: [{
      sku: "SENSOR", binCode: "B5-01", recordedQuantity: 12,
      evidence: { state: "VERIFICATION_EXPIRED", lastVerifiedAt: "2026-09-08T00:00:00Z" },
    }] }).mockResolvedValue({ ok: false, reason: "materials_verification_incomplete", requirements: [{ sku: "SENSOR", quantity: 11 }],
      selectedBins: [], shortages: [{ sku: "SENSOR", required: 11, available: 0 }] });
  mocks.audit.mockResolvedValue({ auditRunId: "audit-run", results: [{ binAuditId: "audit", binCode: "B5-01",
    expectedQuantity: 12, observedQuantity: 10, status: "DISMISSED", reason: "audit_pending_confirmation", confidencePercent: 100 }] });
  mocks.physical.mockResolvedValue({ sku: "SENSOR", binCode: "B5-01", recordedQuantity: 12, observedQuantity: 10,
    usable: true, inventoryUpdated: false, scale: { status: "AGREES", totalWeightGrams: 167, estimatedQuantity: 10 } });
  mocks.inventory.mockResolvedValue({ locations: [{ binCode: "B5-01", quantity: 12, binStatus: "OCCUPIED" }] });
  mocks.evidence.mockResolvedValue(new Map());
});

describe("plan analysis physical evidence", () => {
  it("persists the count of 10 and a shortage of 1 even though recorded inventory remains 12", async () => {
    await executeTodayPlanAnalysis("run");
    const final = mocks.update.mock.calls.find(([input]) => input.data.resultJson)?.[0];
    expect(final).toBeTruthy();
    const result = JSON.parse(final.data.resultJson);
    expect(result.physicalCounts[0]).toMatchObject({ recordedQuantity: 12, observedQuantity: 10, inventoryUpdated: false });
    expect(result.shortages).toEqual([{ sku: "SENSOR", required: 11, available: 10, physicallyAvailable: 10 }]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ reviewPolicy: "REPORT_ONLY" }));
  });
  it("retains successful physical counts when the audit reports no issue", async () => {
    mocks.audit.mockResolvedValue({ auditRunId: "audit-run", results: [{ binAuditId: "audit", binCode: "B5-01",
      expectedQuantity: 10, observedQuantity: 10, status: "VERIFIED", confidencePercent: 100 }] });
    await executeTodayPlanAnalysis("run");
    const final = mocks.update.mock.calls.find(([input]) => input.data.resultJson)?.[0];
    expect(JSON.parse(final.data.resultJson).physicalCounts[0].observedQuantity).toBe(10);
  });
  it("restores physically found 10 from a saved report that previously displayed Verified 0", async () => {
    mocks.latest.mockResolvedValue({ id: "run", status: "COMPLETED_WITH_ISSUES", stage: "COMPLETE", workDate: "2026-09-15",
      resultJson: JSON.stringify({ readiness: "SHORTAGE", verificationAuditRunIds: ["audit-run"],
        selectedBins: [], shortages: [{ sku: "SENSOR", required: 11, available: 0 }], auditIssues: [], auditedBinCodes: ["B5-01"] }),
      events: [{ id: "event", sequence: 1, stage: "AUDITING_BIN", status: "RUNNING", createdAt: new Date(),
        summary: "RackHand chose to verify B5-01 for SENSOR. Recorded: 12. Last verified: 7 days ago." }],
      createdAt: new Date(), updatedAt: new Date(),
    });
    mocks.audits.mockResolvedValue([{ id: "audit", bin: { code: "B5-01" }, expectedPart: { sku: "SENSOR" }, expectedQuantity: 10 }]);
    const view = await getLatestTodayPlanAnalysis("session");
    expect(view?.result?.shortages[0]).toMatchObject({ required: 11, available: 10, physicallyAvailable: 10 });
    expect(mocks.physical).toHaveBeenCalledWith("audit", "SENSOR", 12);
  });
});
