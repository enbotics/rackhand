import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Graph } from "@strands-agents/sdk";
import type { RetrievalResult } from "@/lib/warehouse/retrieval-types";

const fixture = vi.hoisted(() => ({
  part: { id: "part-6", sku: "SPACERS", canonicalName: "Round spacers" },
  bin: { id: "bin-6", code: "B6-03", status: "OCCUPIED" },
  committed: false,
  movementStatus: "COMPLETED",
  delay: 89_000,
  remaining: 29,
  statusAfterCommit: "CHECKED_OUT",
  serviceFailure: false,
  execute: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/lib/warehouse/db", () => ({ prisma: {
  movement: { findUnique: async ({ where }: { where: { id?: string } }) =>
    where.id && fixture.committed ? { id: "movement-6", type: "RETRIEVAL", status: fixture.movementStatus } : null },
  inventory: { findUnique: async () => ({ quantity: fixture.remaining }) },
} }));
vi.mock("@/lib/warehouse/repository", () => ({
  getBinByCode: async () => fixture.bin,
  getPartBySku: async () => fixture.part,
  getPartById: async () => fixture.part,
}));
vi.mock("@/lib/warehouse/inventory-service", () => ({
  getInventoryByBin: async () => [{ sku: "SPACERS", quantity: 29 }],
  getInventoryForPart: async () => ({ totalQuantity: 29,
    locations: [{ binCode: "B6-03", quantity: 29, binStatus: "OCCUPIED" }] }),
}));
vi.mock("@/lib/warehouse/retrieval-service", () => ({
  executeRetrieval: fixture.execute,
  chooseRetrievalSourceBinCode: () => "B6-03",
  createRetrievalRequestId: () => "final-bin",
  RETRIEVAL_IDEMPOTENCY_PREFIX: "retrieval:",
}));
vi.mock("@/lib/agents/request-context", () => ({ getContextTraceId: () => undefined }));
vi.mock("@/lib/observability/graph-tracing", () => ({ traceGraphRun: fixture.trace }));

import {
  createRetrievalGraph, RETRIEVAL_GRAPH_CONFIG, runRetrievalGraph,
} from "@/lib/warehouse/graphs/retrieval-graph";
import { RETRIEVAL_NODE_IDS } from "@/lib/warehouse/graphs/workflow-types";

const success: RetrievalResult = {
  ok: true, requestId: "final-bin", part: { partId: "part-6", sku: "SPACERS", canonicalName: "Round spacers" },
  sourceBinCode: "B6-03", destination: "OUTPUT", movementId: "movement-6", gantryOperationId: "gantry-6",
  checkedOutQuantity: 29, inventoryQuantityRemoved: 0, remainingQuantityInBin: 29,
  binStatus: "CHECKED_OUT", status: "COMPLETED",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.committed = false;
  fixture.movementStatus = "COMPLETED";
  fixture.bin.status = "OCCUPIED";
  fixture.remaining = 29;
  fixture.statusAfterCommit = "CHECKED_OUT";
  fixture.serviceFailure = false;
  fixture.execute.mockImplementation(async () => {
    // Represents gantry motion, camera/scale analysis and human removal/retry.
    await new Promise((resolve) => setTimeout(resolve, fixture.delay));
    if (fixture.serviceFailure) return { ok: false, requestId: "final-bin", reason: "gantry_failed", message: "Motion failed." };
    fixture.committed = true;
    fixture.bin.status = fixture.statusAfterCommit;
    return success;
  });
});
afterEach(() => vi.useRealTimers());

function graphWithOriginalTimeout() {
  const template = createRetrievalGraph();
  return new Graph({
    id: template.id, nodes: [...template.nodes.values()],
    edges: template.edges.map(({ source, target, handler }) => ({ source: source.id, target: target.id, handler })),
    ...RETRIEVAL_GRAPH_CONFIG, timeout: 60_000,
  });
}

async function finishSlowStep() {
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.execute).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(fixture.delay);
}

describe("retrieval verification timeout", () => {
  it("allows the camera/retry window while remaining below the route ceiling", () => {
    expect(RETRIEVAL_GRAPH_CONFIG.timeout).toBe(290_000);
    expect(RETRIEVAL_GRAPH_CONFIG.timeout).toBeLessThan(300_000);
  });

  it("finishes the slow final bin normally so its successful checkout can offer putaway", async () => {
    const completion = runRetrievalGraph({ sourceBinCode: "B6-03", requestId: "final-bin" }, createRetrievalGraph());
    await finishSlowStep();
    const run = await completion;
    expect(run.result).toBe(success);
    expect(run.graph.status).toBe("COMPLETED");
    expect(run.graph.steps.every((step) => step.status === "COMPLETED")).toBe(true);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("recovers a coherent committed checkout even when the SDK expires after motion", async () => {
    const completion = runRetrievalGraph({ sourceBinCode: "B6-03", requestId: "final-bin" }, graphWithOriginalTimeout());
    await finishSlowStep();
    const run = await completion;
    expect(run.result).toBe(success);
    expect(run.graph).toMatchObject({ status: "COMPLETED", movementId: "movement-6" });
    expect(run.graph.steps.every((step) => step.status === "COMPLETED")).toBe(true);
    expect(run.graph.steps.find((step) => step.nodeId === RETRIEVAL_NODE_IDS.verify)?.status).toBe("COMPLETED");
    expect(fixture.trace).toHaveBeenCalledWith(expect.objectContaining({ result: success }));
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["bin", "inventory", "movement"])("does not approve an incoherent %s after a late commit", async (problem) => {
    if (problem === "bin") fixture.statusAfterCommit = "RESERVED";
    else if (problem === "movement") fixture.movementStatus = "FAILED";
    else fixture.remaining = 28;
    const completion = runRetrievalGraph({ sourceBinCode: "B6-03", requestId: "final-bin" }, graphWithOriginalTimeout());
    await finishSlowStep();
    const run = await completion;
    expect(run.result).toMatchObject({ ok: false, reason: "retrieval_verification_failed" });
    expect(run.graph.status).toBe("FAILED");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("does not turn a failed physical service into success", async () => {
    fixture.serviceFailure = true;
    const completion = runRetrievalGraph({ sourceBinCode: "B6-03", requestId: "final-bin" }, graphWithOriginalTimeout());
    const rejected = expect(completion).rejects.toThrow("graph exceeded wall-clock budget");
    await finishSlowStep();
    await rejected;
    expect(fixture.committed).toBe(false);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("does not hide unrelated orchestration errors", async () => {
    const graph = createRetrievalGraph();
    vi.spyOn(graph, "invoke").mockRejectedValueOnce(new Error("Unexpected graph error"));
    await expect(runRetrievalGraph({ sourceBinCode: "B6-03" }, graph)).rejects.toThrow("Unexpected graph error");
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});
