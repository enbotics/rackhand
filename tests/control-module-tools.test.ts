import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ retrieveGraph: vi.fn(), returnBin: vi.fn(), intakeGraph: vi.fn(), prepare: vi.fn(), demoPlan: vi.fn() }));
vi.mock("@/lib/warehouse/graphs/retrieval-graph", () => ({ runRetrievalGraph: fixture.retrieveGraph }));
vi.mock("@/lib/warehouse/graphs/putaway-graph", () => ({ runPutawayGraph: fixture.intakeGraph }));
vi.mock("@/lib/warehouse/putaway-service", () => ({ returnCheckedOutBin: fixture.returnBin }));
vi.mock("@/lib/warehouse/materials-fulfillment-service", () => ({ prepareMaterialsFulfillment: fixture.prepare }));
vi.mock("@/lib/warehouse/control-module-scenario", () => ({
  controlModuleCurrentBin: () => "B6-03",
  controlModuleCurrentPart: () => ({ binCode: "B6-03", sku: "SPACERS" }),
  controlModuleScenarioPlan: fixture.demoPlan,
}));

import { runWithRequestContext, getContextWorkflows } from "@/lib/agents/request-context";
import { executeRetrievalTool } from "@/lib/agents/tools/execute-retrieval";
import { executePutawayTool } from "@/lib/agents/tools/execute-putaway";
import { fulfillMaterialsPlanTool } from "@/lib/agents/tools/fulfill-materials-plan";

const returned = { ok: true, movementId: "returned-6", gantryOperationId: "gantry-return-6",
  destinationBinCode: "B6-03", inventoryQuantityAfter: 29 };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.returnBin.mockResolvedValue(returned);
  fixture.retrieveGraph.mockImplementation(async ({ sourceBinCode }: { sourceBinCode: string }) => ({
    result: { ok: true, sourceBinCode, checkedOutQuantity: 30 },
    graph: { workflow: "RETRIEVAL", status: "COMPLETED", operationId: "retrieve-6", movementId: "m-6", gantryOperationId: "g-6", steps: [] },
  }));
});

describe("control module tool queue bindings", () => {
  it("binds queued retrieval to the approved bin and SKU, not model substitutions", async () => {
    await runWithRequestContext({ workflowSessionId: "demo", browserScenario: "CONTROL_MODULE" }, () =>
      executeRetrievalTool.invoke({ sourceBinCode: "B3-03", sku: "WRONG" }));
    expect(fixture.retrieveGraph).toHaveBeenCalledWith(expect.objectContaining({ sourceBinCode: "B6-03", sku: "SPACERS" }));
  });

  it("returns the third bin to B6-03 and records completion for the final report card", async () => {
    const workflows = await runWithRequestContext({ workflowSessionId: "demo", browserScenario: "CONTROL_MODULE" }, async () => {
      await executePutawayTool.invoke({ binCode: "B3-03" });
      return getContextWorkflows();
    });
    expect(fixture.returnBin).toHaveBeenCalledWith({ binCode: "B6-03" });
    expect(workflows[0]).toMatchObject({ workflow: "PUTAWAY", status: "COMPLETED", movementId: "returned-6" });
    expect(fixture.intakeGraph).not.toHaveBeenCalled();
  });

  it("does not bind an unrelated user request to an older demo in the same session", async () => {
    await runWithRequestContext({ workflowSessionId: "demo" }, () => executePutawayTool.invoke({ binCode: "B3-03" }));
    expect(fixture.returnBin).toHaveBeenCalledWith({ binCode: "B3-03" });
  });

  it("does not report a failed return as completed", async () => {
    fixture.returnBin.mockResolvedValueOnce({ ok: false, reason: "photo_required", message: "Check did not pass." });
    const workflows = await runWithRequestContext({}, async () => {
      await executePutawayTool.invoke({ binCode: "B6-03" });
      return getContextWorkflows();
    });
    expect(workflows[0]).toMatchObject({ workflow: "PUTAWAY", status: "BLOCKED" });
  });

  it("starts the approved three-bin prep with checkout verification enabled", async () => {
    const selectedBins = ["B4-01", "B3-03", "B6-03"].map((binCode) => ({ binCode, sku: binCode, recordedQuantity: 12, requiredQuantity: 1 }));
    fixture.demoPlan.mockReturnValueOnce({ ok: true, selectedBins, requirements: [] });
    const result = await runWithRequestContext({ workflowSessionId: "demo", browserScenario: "CONTROL_MODULE" }, () =>
      fulfillMaterialsPlanTool.invoke({ requirements: [{ sku: "HARDWARE", purpose: "assembly", category: "hardware", quantity: 1 }] }));
    expect(fixture.retrieveGraph).toHaveBeenCalledWith(expect.objectContaining({ sourceBinCode: "B4-01", verifyContents: true }));
    expect(result).toMatchObject({ fulfillmentTotal: 3, remainingBinCodes: ["B3-03", "B6-03"] });
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
});
