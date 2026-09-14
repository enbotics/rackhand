import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ readBin: vi.fn(), readActive: vi.fn(), retrieve: vi.fn(), stock: vi.fn(),
  claim: vi.fn(), pending: vi.fn(), settle: vi.fn(),
}));
vi.mock("@/lib/warehouse/db", () => ({ prisma: {
  $transaction: async (read: (tx: unknown) => Promise<unknown>) => read({
    bin: { findUnique: fixture.readBin }, movement: { findFirst: fixture.readActive },
  }),
  bin: { findMany: async () => [await fixture.readBin()] },
} }));
vi.mock("@/lib/warehouse/inventory-service", () => ({ getInventoryForPart: fixture.stock }));
vi.mock("@/lib/warehouse/bin-verification-evidence", () => ({ getBinVerificationEvidence: async () => new Map() }));
vi.mock("@/lib/warehouse/graphs/retrieval-graph", () => ({ runRetrievalGraph: fixture.retrieve }));
vi.mock("@/lib/camera/storage", () => ({ readCameraCapture: vi.fn() }));
vi.mock("@/lib/warehouse/storage", () => ({ uploadPutawayPhoto: vi.fn() }));
vi.mock("@/lib/warehouse/control-module-scenario", () => ({ controlModuleScenarioPlan: () => null }));
vi.mock("@/lib/agents/approval-store", () => ({
  claimApproval: fixture.claim, createPendingApproval: fixture.pending, settleApproval: fixture.settle,
  settleStaleApprovalForSession: async () => null,
}));
vi.mock("@/lib/observability/trace-service", () => ({
  recordEvent: vi.fn(), completeTrace: vi.fn(), setTraceStatus: vi.fn(), startTrace: vi.fn(),
}));

import { resumeMaterialsCheckout } from "@/lib/warehouse/materials-checkout-service";
import { fulfillMaterialsPlanTool } from "@/lib/agents/tools/fulfill-materials-plan";
import { getContextWorkflows, runWithRequestContext } from "@/lib/agents/request-context";
import { createWarehouseAgent, resumeWarehouseAgent } from "@/lib/agents/warehouse-agent";
import type { ApprovalSummary } from "@/lib/agents/approval-store";
import { ScriptedModel, textTurn, toolUseTurn } from "./scripted-model";

const part = { id: "screw-part", sku: "SCREW-M4-30", canonicalName: "M4 x 30 Self-Tapping Screw" };
const checkout = {
  id: "earlier-checkout", type: "RETRIEVAL", status: "COMPLETED", partId: part.id,
  destinationLocation: "OUTPUT", gantryOperationId: "earlier-gantry", newQuantity: 18,
  verificationImageUrl: "/audit-simulation/B1-01/snapshot.jpg", verificationCapturedAt: new Date(),
};
const bin = () => ({ id: "screw-bin", code: "B1-01", status: "CHECKED_OUT",
  inventory: [{ partId: part.id, quantity: 18, part }], movementsFromThisBin: [{ ...checkout }],
});
const selection = { sku: part.sku, binCode: "B1-01", recordedQuantity: 18, requiredQuantity: 10, alreadyCheckedOut: true };
const requirements = [{ sku: part.sku, quantity: 10, purpose: "sensor enclosure", category: "screws" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WAREHOUSE_SIMULATION_LOCKED", "true");
  fixture.readBin.mockImplementation(async () => bin());
  fixture.readActive.mockResolvedValue(null);
  fixture.stock.mockImplementation(async (sku: string) => ({
    part: { ...part, sku }, totalQuantity: sku === part.sku ? 0 : 6,
    checkedOutQuantity: sku === part.sku ? 18 : 0, recordedQuantity: sku === part.sku ? 18 : 6,
    locations: [sku === part.sku
      ? { binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 }
      : { binCode: "B1-02", binStatus: "OCCUPIED", quantity: 6 }],
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("materials preparation from an existing simulation checkout", () => {
  it("offers the exact bin's automatic return through the real Strands approval resume", async () => {
    const original = createWarehouseAgent(new ScriptedModel([
      toolUseTurn("fulfill_materials_plan", "fulfill", JSON.stringify({ requirements })),
    ]));
    const paused = await original.invoke("Prep the screws for the sensor enclosure.");
    expect(paused.stopReason).toBe("interrupt");
    const interrupt = paused.interrupts![0];
    fixture.claim.mockResolvedValueOnce({ ok: true, createdAt: new Date(), approval: {
      toolName: "fulfill_materials_plan", interruptId: interrupt.id,
      snapshot: original.takeSnapshot({ preset: "session" }), requestId: "prep",
      traceId: null, sessionId: null, scanResult: null, scanImageDataUrl: null, catalogResolutionId: null,
      summary: { action: "MATERIALS_FULFILLMENT", quantity: 1 },
    } });
    fixture.pending.mockImplementation(async ({ summary, interruptId, toolName }: {
      summary: ApprovalSummary; interruptId: string; toolName: string;
    }) => ({ approvalId: "return-approval", interruptId, action: toolName, summary, expiresAt: new Date().toISOString() }));

    const resumed = await resumeWarehouseAgent("prep-approval", "APPROVE", () =>
      createWarehouseAgent(new ScriptedModel([
        textTurn("The bin is ready."),
        toolUseTurn("execute_putaway", "return", '{"binCode":"B1-01"}'),
      ])));
    expect(resumed).toMatchObject({ ok: true, reply: { status: "APPROVAL_REQUIRED",
      message: expect.stringContaining("is ready at checkout"),
      approval: { action: "execute_putaway", summary: {
        destination: "B1-01", autoSuggested: true, fulfillmentQueue: [], fulfillmentTotal: 1,
      } },
    } });
    expect(fixture.retrieve).not.toHaveBeenCalled();
    expect(fixture.settle).toHaveBeenCalledWith("prep-approval", "APPROVED");
  });

  it("starts the real fulfillment tool without a new retrieval or a zero-stock failure", async () => {
    const result = await runWithRequestContext({ requestId: "prep", workflowSessionId: "session" }, async () => {
      const reply = await fulfillMaterialsPlanTool.invoke({ requirements });
      expect(getContextWorkflows()).toEqual([]);
      return reply;
    });
    expect(result).toMatchObject({ ok: true, alreadyAtCheckout: true,
      sourceBinCode: "B1-01", checkedOutQuantity: 18, inventoryQuantityRemoved: 0,
      movementId: "earlier-checkout", gantryOperationId: "earlier-gantry",
      fulfillmentTotal: 1, remainingBinCodes: [],
    });
    expect(fixture.retrieve).not.toHaveBeenCalled();
  });

  it("keeps the other selected bin queued until the checkout is returned", async () => {
    const result = await runWithRequestContext({}, () => fulfillMaterialsPlanTool.invoke({
      requirements: [{ sku: "BRACKET", quantity: 2, purpose: "mount", category: "bracket" }, ...requirements],
    }));
    expect(result).toMatchObject({ ok: true, sourceBinCode: "B1-01", alreadyAtCheckout: true,
      fulfillmentTotal: 2, remainingBinCodes: ["B1-02"],
    });
    expect(fixture.retrieve).not.toHaveBeenCalled();
  });

  it.each(["AWAITING_VERIFICATION", "RETURNING"])("blocks an unfinished %s workflow", async (status) => {
    fixture.readActive.mockResolvedValueOnce({ id: "active", status });
    expect(await resumeMaterialsCheckout(selection, "prep"))
      .toMatchObject({ ok: false, reason: "inventory_conflict", message: expect.stringContaining("unfinished") });
  });

  it.each(["FAILED", "AWAITING_VERIFICATION"])("does not reuse a %s checkout as a completed check", async (status) => {
    const current = bin();
    current.movementsFromThisBin[0].status = status;
    fixture.readBin.mockResolvedValueOnce(current);
    expect(await resumeMaterialsCheckout(selection, "prep"))
      .toMatchObject({ ok: false, message: expect.stringContaining("Request putaway to verify and return") });
  });

  it("revalidates inventory after the plan selected the checkout", async () => {
    const current = bin();
    current.inventory[0].quantity = 8;
    fixture.readBin.mockResolvedValueOnce(current);
    expect(await resumeMaterialsCheckout(selection, "prep"))
      .toMatchObject({ ok: false, message: expect.stringContaining("stock changed") });
  });

  it("still retrieves and verifies a bin that is on its shelf", async () => {
    fixture.stock.mockResolvedValueOnce({ part, totalQuantity: 18, checkedOutQuantity: 0, recordedQuantity: 18,
      locations: [{ binCode: "B1-01", binStatus: "OCCUPIED", quantity: 18 }],
    });
    fixture.retrieve.mockResolvedValueOnce({
      result: { ok: true, sourceBinCode: "B1-01", checkedOutQuantity: 18 },
      graph: { workflow: "RETRIEVAL", status: "COMPLETED", operationId: "new-retrieval", steps: [] },
    });
    const result = await runWithRequestContext({}, () => fulfillMaterialsPlanTool.invoke({ requirements }));
    expect(result).toMatchObject({ ok: true });
    expect(fixture.retrieve).toHaveBeenCalledWith(expect.objectContaining({ sourceBinCode: "B1-01", verifyContents: true }));
    expect(fixture.readBin).not.toHaveBeenCalled();
  });

  it("rejects bins outside simulation scope before reading or changing state", async () => {
    expect(await resumeMaterialsCheckout({ ...selection, binCode: "B5-01" }, "prep"))
      .toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    expect(fixture.readBin).not.toHaveBeenCalled();
  });

  it("keeps production preparation on the existing shelf-only path", async () => {
    vi.stubEnv("WAREHOUSE_SIMULATION_LOCKED", "false");
    vi.stubEnv("AUDIT_CAPTURE_MODE", "PROD");
    const result = await runWithRequestContext({}, () => fulfillMaterialsPlanTool.invoke({ requirements }));
    expect(result).toMatchObject({ ok: false, reason: "materials_shortage" });
    expect(fixture.readBin).not.toHaveBeenCalled();
    expect(fixture.retrieve).not.toHaveBeenCalled();
  });
});
