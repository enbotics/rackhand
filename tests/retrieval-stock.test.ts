import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PartInventorySummary } from "@/lib/warehouse/types";

const fixture = vi.hoisted(() => ({
  part: { id: "screw-1", sku: "SCREW-M4-30", canonicalName: "M4 x 30 Self-Tapping Screw" },
  bin: { id: "bin-1", code: "B1-01", status: "CHECKED_OUT" },
  execute: vi.fn(),
  stock: vi.fn(),
}));
vi.mock("@/lib/warehouse/db", () => ({ prisma: { movement: { findUnique: async () => null } } }));
vi.mock("@/lib/warehouse/repository", () => ({
  getPartBySku: async () => fixture.part,
  getPartById: async () => fixture.part,
  getBinByCode: async () => fixture.bin,
}));
vi.mock("@/lib/warehouse/inventory-service", () => ({
  getInventoryForPart: fixture.stock,
  getInventoryByBin: async () => [{ sku: fixture.part.sku, quantity: 18 }],
}));
vi.mock("@/lib/warehouse/retrieval-service", () => ({
  executeRetrieval: fixture.execute,
  createRetrievalRequestId: () => "screw-request",
  chooseRetrievalSourceBinCode: (locations: Array<{ binCode: string }>) => locations[0]?.binCode ?? null,
  RETRIEVAL_IDEMPOTENCY_PREFIX: "retrieval:",
}));
vi.mock("@/lib/agents/request-context", () => ({ getContextTraceId: () => undefined }));
vi.mock("@/lib/observability/graph-tracing", () => ({ traceGraphRun: vi.fn() }));

import { retrievalStockIssue } from "@/lib/warehouse/retrieval-stock";
import { createRetrievalGraph, runRetrievalGraph } from "@/lib/warehouse/graphs/retrieval-graph";

const summary = (locations: PartInventorySummary["locations"]): PartInventorySummary => ({
  part: fixture.part,
  totalQuantity: locations.filter((location) => location.binStatus === "OCCUPIED").reduce((sum, row) => sum + row.quantity, 0),
  checkedOutQuantity: locations.filter((location) => location.binStatus === "CHECKED_OUT").reduce((sum, row) => sum + row.quantity, 0),
  recordedQuantity: locations.reduce((sum, row) => sum + row.quantity, 0),
  locations,
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.stock.mockResolvedValue(summary([{ binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 }]));
});

describe("retrieval stock availability", () => {
  it.each([{ sku: "SCREW-M4-30" }, { sourceBinCode: "B1-01" }])("keeps checked-out screws out of the physical graph for %j", async (request) => {
    const run = await runRetrievalGraph(request, createRetrievalGraph());
    expect(run.result).toMatchObject({ ok: false, reason: "source_bin_checked_out", sourceBinCode: "B1-01",
      message: expect.stringContaining("already at checkout with 18 recorded units") });
    expect(run.graph.status).toBe("BLOCKED");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("still reports out_of_stock when the part has no recorded stock", () => {
    expect(retrievalStockIssue(summary([]))).toMatchObject({ reason: "out_of_stock" });
    expect(retrievalStockIssue(summary([{ binCode: "B1-01", binStatus: "OCCUPIED", quantity: 0 }]))).toMatchObject({ reason: "out_of_stock" });
  });

  it.each(["RESERVED", "AUDITING", "DISABLED"] as const)("reports stock in a %s bin as unavailable rather than absent", (binStatus) => {
    expect(retrievalStockIssue(summary([{ binCode: "B1-01", binStatus, quantity: 18 }]))).toMatchObject({
      reason: "inventory_conflict", message: expect.stringContaining(`B1-01 (${binStatus})`),
    });
  });

  it("allows other shelf stock while respecting an explicitly requested checked-out bin", () => {
    const stock = summary([
      { binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 },
      { binCode: "B1-02", binStatus: "OCCUPIED", quantity: 5 },
    ]);
    expect(retrievalStockIssue(stock)).toBeNull();
    expect(retrievalStockIssue(stock, " b1-01 ")).toMatchObject({ reason: "source_bin_checked_out", sourceBinCode: "B1-01" });
    expect(retrievalStockIssue(stock, "B1-02")).toBeNull();
    expect(retrievalStockIssue(stock, "B1-03")).toBeNull();
    expect(retrievalStockIssue(summary([{ binCode: "B1-01", binStatus: "CHECKED_OUT", quantity: 18 }]), "B1-02")).toBeNull();
  });
});
