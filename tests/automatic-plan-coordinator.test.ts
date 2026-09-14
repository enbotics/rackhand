import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inboxUpdate: vi.fn(), inboxUpsert: vi.fn(), inboxLoad: vi.fn(), pending: vi.fn(),
  runUpdate: vi.fn(), runFind: vi.fn(), runCreate: vi.fn(), eventFind: vi.fn(), eventCreate: vi.fn(),
  readSheet: vi.fn(), idle: vi.fn(), execute: vi.fn(), recover: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/warehouse/db", () => {
  const prisma = {
    engineeringPlanInbox: { updateMany: mocks.inboxUpdate, upsert: mocks.inboxUpsert,
      findUniqueOrThrow: mocks.inboxLoad, findFirst: mocks.pending },
    engineeringPlanAnalysisRun: { updateMany: mocks.runUpdate, findFirst: mocks.runFind, create: mocks.runCreate },
    engineeringPlanAnalysisEvent: { findFirst: mocks.eventFind, create: mocks.eventCreate },
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
  };
  return { prisma };
});
vi.mock("@/lib/engineering-plan/google-sheets", () => ({
  getEngineeringPlanContextForWorkDate: mocks.readSheet, tomorrowEngineeringPlanWorkDate: () => "2026-09-15",
}));
vi.mock("@/lib/engineering-plan/idle-service", () => ({ warehouseIdleReason: mocks.idle }));
vi.mock("@/lib/engineering-plan/analysis-service", () => ({
  executeTodayPlanAnalysis: mocks.execute, recoverAbandonedTodayPlanAnalysis: mocks.recover,
}));
import { coordinateAutomaticPlans, recordEngineeringPlanChange } from "@/lib/engineering-plan/auto-coordinator";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENGINEERING_PLAN_AUTO_ENABLED", "true");
  vi.stubEnv("ENGINEERING_PLAN_SPREADSHEET_ID", "sheet");
  mocks.inboxUpdate.mockResolvedValue({ count: 0 });
  mocks.pending.mockResolvedValue(null);
  mocks.runFind.mockResolvedValue(null);
  mocks.idle.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("durable automatic tomorrow-plan coordination", () => {
  it("does nothing when automatic triggering is disabled", async () => {
    vi.stubEnv("ENGINEERING_PLAN_AUTO_ENABLED", "false");
    await coordinateAutomaticPlans();
    expect(mocks.inboxUpdate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("only a strictly newer signal may renew the debounce", async () => {
    await recordEngineeringPlanChange("sheet", 1_000_000);
    expect(mocks.inboxUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(mocks.inboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sheet", signalAt: { lt: new Date(1_000_000) } },
    }));
  });
  it("does not audit an old snapshot while a newer Sheet signal is pending", async () => {
    mocks.pending.mockResolvedValue({ pending: true });
    await coordinateAutomaticPlans();
    expect(mocks.idle).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("keeps queued work waiting and explains client priority", async () => {
    mocks.runFind.mockResolvedValueOnce({ id: "new", createdAt: new Date() }).mockResolvedValueOnce(null);
    mocks.idle.mockResolvedValue("A client request has priority.");
    mocks.eventFind.mockResolvedValue({ sequence: 1, summary: "queued" });
    await coordinateAutomaticPlans();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.eventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      stage: "WAITING_FOR_IDLE", summary: "A client request has priority.",
    }) });
  });
  it("does not duplicate unchanged waiting-status events", async () => {
    mocks.runFind.mockResolvedValueOnce({ id: "new", createdAt: new Date() }).mockResolvedValueOnce(null);
    mocks.idle.mockResolvedValue("Waiting for the gantry.");
    mocks.eventFind.mockResolvedValue({ sequence: 2, summary: "Waiting for the gantry." });
    await coordinateAutomaticPlans();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
  it("starts the latest queued analysis only after the idle check", async () => {
    mocks.runFind.mockResolvedValueOnce({ id: "new", createdAt: new Date() }).mockResolvedValueOnce(null);
    await coordinateAutomaticPlans();
    expect(mocks.execute).toHaveBeenCalledWith("new");
    expect(mocks.runUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "QUEUED", activeKey: null }),
    }));
  });
  it("never interferes with an active manual analysis", async () => {
    mocks.runFind.mockResolvedValueOnce({ id: "queued" }).mockResolvedValueOnce({ id: "manual", activeKey: "ACTIVE" });
    await coordinateAutomaticPlans();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("keeps a Sheet-read failure pending and backs off instead of declaring no plan", async () => {
    mocks.inboxUpdate.mockResolvedValue({ count: 1 });
    mocks.inboxLoad.mockResolvedValue({ signalAt: new Date(), lastFingerprint: null });
    mocks.readSheet.mockResolvedValue({ configured: true, reason: "unavailable", rows: [] });
    await coordinateAutomaticPlans();
    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.inboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: expect.stringContaining("safely queued") }),
    }));
  });
  it("snapshots actionable tomorrow rows and replaces only waiting versions", async () => {
    mocks.inboxUpdate.mockResolvedValue({ count: 1 });
    const signalAt = new Date();
    mocks.inboxLoad.mockResolvedValue({ signalAt, lastFingerprint: null });
    const context = { configured: true, currentWorkDate: "2026-09-15", rows: [
      { planId: "WO-1", project: "Frame", buildTask: "Frame", status: "RELEASED", priority: "HIGH", quantityScale: "4 ea" },
    ] };
    mocks.readSheet.mockResolvedValue(context);
    await coordinateAutomaticPlans();
    expect(mocks.runCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      trigger: "SHEET_CHANGE", stage: "WAITING_FOR_IDLE", sourceContextJson: JSON.stringify(context),
    }) });
    expect(mocks.runUpdate).toHaveBeenCalledWith({
      where: { trigger: "SHEET_CHANGE", status: "QUEUED", activeKey: null },
      data: expect.objectContaining({ status: "SUPERSEDED" }),
    });
    expect(mocks.inboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ signalAt, leaseUntil: { gt: expect.any(Date) } }),
    }));
  });
});
