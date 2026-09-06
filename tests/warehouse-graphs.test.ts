import { beforeEach, describe, expect, it } from "vitest";
import { BeforeNodeCallEvent } from "@strands-agents/sdk/multiagent";
import { prisma } from "@/lib/warehouse/db";
import { createPart, setBinStatus } from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { SimulatedGantryController } from "@/lib/gantry/simulator";
import {
  createPutawayGraph,
  getPutawayGraph,
  PUTAWAY_GRAPH_CONFIG,
  runPutawayGraph,
} from "@/lib/warehouse/graphs/putaway-graph";
import {
  createRetrievalGraph,
  getRetrievalGraph,
  RETRIEVAL_GRAPH_CONFIG,
  runRetrievalGraph,
} from "@/lib/warehouse/graphs/retrieval-graph";
import {
  PUTAWAY_NODE_IDS,
  PUTAWAY_NODE_ORDER,
  RETRIEVAL_NODE_IDS,
  RETRIEVAL_NODE_ORDER,
  type WarehouseGraphResult,
  type WorkflowStepStatus,
} from "@/lib/warehouse/graphs/workflow-types";
import { createWarehouseAgent, invokeWarehouseAgent, resumeWarehouseAgent } from "@/lib/agents/warehouse-agent";
import { clearPendingApprovals } from "@/lib/agents/approval-store";
import { requestCatalogResolution, confirmCatalogResolution } from "@/lib/warehouse/catalog-resolution-service";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { ScriptedModel, textTurn, toolUseTurn } from "./scripted-model";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 11 — the two Strands graphs.
 *
 * The graphs coordinate; the Milestone 7/8 services stay authoritative. So
 * these tests ask two kinds of question:
 *
 *  1. Does the ORCHESTRATION do what the topology says — does execution only
 *     ever happen after its prerequisites, and does a blocked stage really
 *     stop everything downstream?
 *  2. Did wrapping the services in a graph weaken any guarantee they already
 *     had — idempotency, concurrency safety, "no inventory before the gantry
 *     succeeded", "no automatic physical retry"?
 *
 * The second is the one that matters. A graph that orchestrates beautifully
 * and lets stock go negative is a worse system than no graph at all.
 */

const BEARING = {
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 20mm bore",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};

/** Two near-identical bolts, so the matcher genuinely returns AMBIGUOUS. */
const BOLT = {
  sku: "BOLT-M8-50",
  canonicalName: "M8 x 50 Hex Bolt",
  category: "fastener",
  description: "Zinc plated hex head bolt",
  lengthMM: 50,
  widthMM: 13,
  heightMM: 5.3,
};
const BOLT_FLANGE = {
  sku: "BOLT-M8-50-FLG",
  canonicalName: "M8 x 50 Flange Bolt",
  category: "fastener",
  description: "Zinc plated flange head bolt",
  lengthMM: 50,
  widthMM: 14,
  heightMM: 5.3,
};

function bearingScan(scanId = "scan_1788574200123_g1"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200123,
    object: { detectedName: "6204 bearing", description: "Metal circular bearing." },
    dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

function boltScan(scanId = "scan_1788574200999_amb"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200999,
    object: { detectedName: "m8 hex bolt", description: "Steel bolt with hex head." },
    dimensions: { lengthMM: 50.2, widthMM: 13.4, heightMM: 5.3 },
    quality: { dimensionConfidence: 0.94, calibrationRmsPixels: 1.2 },
    orientation: { angleDegrees: 8 },
  };
}

const simulator = () => getGantryController() as SimulatedGantryController;

/** Node id -> reported status, for compact assertions. */
function statuses(graph: WarehouseGraphResult): Record<string, WorkflowStepStatus> {
  return Object.fromEntries(graph.steps.map((step) => [step.nodeId, step.status]));
}

async function inventoryTotal(sku: string): Promise<number> {
  const part = await prisma.part.findUnique({ where: { sku } });
  if (!part) return 0;
  const rows = await prisma.inventory.findMany({ where: { partId: part.id } });
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

const scripted = (turns: ReturnType<typeof textTurn>[]) => () =>
  createWarehouseAgent(new ScriptedModel(turns));

beforeEach(async () => {
  await resetWarehouse();
  resetGantryController();
  clearPendingApprovals();
  await createPart(BEARING);
});

/* ------------------------------------------------------------ topology */

describe("graph topology", () => {
  it("builds the putaway workflow from the official Strands Graph", () => {
    const graph = getPutawayGraph();

    expect(graph.id).toBe("warehouse_putaway");
    expect([...graph.nodes.keys()]).toEqual([...PUTAWAY_NODE_ORDER]);
    expect(graph.edges.map((edge) => [edge.source.id, edge.target.id])).toEqual([
      [PUTAWAY_NODE_IDS.validate, PUTAWAY_NODE_IDS.identity],
      [PUTAWAY_NODE_IDS.identity, PUTAWAY_NODE_IDS.destination],
      [PUTAWAY_NODE_IDS.destination, PUTAWAY_NODE_IDS.preflight],
      [PUTAWAY_NODE_IDS.preflight, PUTAWAY_NODE_IDS.execute],
      [PUTAWAY_NODE_IDS.execute, PUTAWAY_NODE_IDS.verify],
    ]);
  });

  it("builds the retrieval workflow from the official Strands Graph", () => {
    const graph = getRetrievalGraph();

    expect(graph.id).toBe("warehouse_retrieval");
    expect([...graph.nodes.keys()]).toEqual([...RETRIEVAL_NODE_ORDER]);
    expect(graph.edges.map((edge) => [edge.source.id, edge.target.id])).toEqual([
      [RETRIEVAL_NODE_IDS.validate, RETRIEVAL_NODE_IDS.part],
      [RETRIEVAL_NODE_IDS.part, RETRIEVAL_NODE_IDS.inventory],
      [RETRIEVAL_NODE_IDS.inventory, RETRIEVAL_NODE_IDS.source],
      [RETRIEVAL_NODE_IDS.source, RETRIEVAL_NODE_IDS.preflight],
      [RETRIEVAL_NODE_IDS.preflight, RETRIEVAL_NODE_IDS.execute],
      [RETRIEVAL_NODE_IDS.execute, RETRIEVAL_NODE_IDS.verify],
    ]);
  });

  it("cannot reach an execute node without every prerequisite stage", () => {
    // Walk backwards from execute; the only route to it is the full chain, so
    // there is no edge that skips validation, identity or preflight.
    for (const [graph, executeId, order] of [
      [getPutawayGraph(), PUTAWAY_NODE_IDS.execute, PUTAWAY_NODE_ORDER] as const,
      [getRetrievalGraph(), RETRIEVAL_NODE_IDS.execute, RETRIEVAL_NODE_ORDER] as const,
    ]) {
      const chain: string[] = [executeId];
      let current = executeId as string;
      for (;;) {
        const incoming = graph.edges.filter((edge) => edge.target.id === current);
        expect(incoming.length).toBeLessThanOrEqual(1);
        if (incoming.length === 0) break;
        current = incoming[0].source.id;
        chain.unshift(current);
      }
      // Every stage before execute, in order, with nothing missing.
      expect(chain).toEqual(order.slice(0, order.indexOf(executeId) + 1));
    }
  });

  it("is acyclic, so a failed physical action can never be retried by a loop", () => {
    for (const graph of [getPutawayGraph(), getRetrievalGraph()]) {
      const seen = new Set<string>();
      const stack = new Set<string>();
      const visit = (id: string): void => {
        if (stack.has(id)) throw new Error(`cycle through ${id}`);
        if (seen.has(id)) return;
        seen.add(id);
        stack.add(id);
        for (const edge of graph.edges.filter((e) => e.source.id === id)) visit(edge.target.id);
        stack.delete(id);
      };
      expect(() => [...graph.nodes.keys()].forEach(visit)).not.toThrow();
    }
  });

  it("bounds execution well above the node count but nowhere near a runaway", () => {
    expect(PUTAWAY_GRAPH_CONFIG.maxSteps).toBeGreaterThan(PUTAWAY_NODE_ORDER.length);
    expect(PUTAWAY_GRAPH_CONFIG.maxSteps).toBeLessThan(50);
    expect(RETRIEVAL_GRAPH_CONFIG.maxSteps).toBeGreaterThan(RETRIEVAL_NODE_ORDER.length);
    expect(RETRIEVAL_GRAPH_CONFIG.maxSteps).toBeLessThan(50);

    for (const config of [PUTAWAY_GRAPH_CONFIG, RETRIEVAL_GRAPH_CONFIG]) {
      expect(config.timeout).toBeGreaterThan(0);
      expect(config.maxConcurrency).toBe(1);
      expect(getPutawayGraph().config.maxSteps).toBe(PUTAWAY_GRAPH_CONFIG.maxSteps);
    }
  });

  it("contains no agent or model node — every node is deterministic code", () => {
    for (const graph of [getPutawayGraph(), getRetrievalGraph()]) {
      for (const node of graph.nodes.values()) {
        expect(node.type).toBe("warehouseWorkflowNode");
      }
    }
  });
});

/* ------------------------------------------------------------- putaway */

describe("putaway graph", () => {
  it("Test 1 — completes every stage and stores exactly one item", async () => {
    const { graph, result } = await runPutawayGraph({ scanResult: bearingScan() });

    expect(graph.status).toBe("COMPLETED");
    expect(statuses(graph)).toEqual({
      putaway_validate: "COMPLETED",
      putaway_identity: "COMPLETED",
      putaway_destination: "COMPLETED",
      putaway_preflight: "COMPLETED",
      putaway_execute: "COMPLETED",
      putaway_verify: "COMPLETED",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventoryQuantityAdded).toBe(1);
    expect(result.identity.source).toBe("DETERMINISTIC_MATCH");

    // Exactly one of each, from authoritative state.
    expect(await prisma.movement.count()).toBe(1);
    expect(await inventoryTotal("BRG-6204")).toBe(1);
    expect((await simulator().getRecentOperations()).length).toBe(1);
    expect(graph.status === "COMPLETED" && graph.movementId).toBe(result.movementId);
  });

  it("Test 2 — an ambiguous match blocks at identity and never executes", async () => {
    await createPart(BOLT);
    await createPart(BOLT_FLANGE);

    const { graph, result } = await runPutawayGraph({ scanResult: boltScan() });

    expect(graph.status).toBe("BLOCKED");
    expect(graph.status === "BLOCKED" && graph.reason).toBe("catalog_match_ambiguous");
    expect(statuses(graph)).toMatchObject({
      putaway_validate: "COMPLETED",
      putaway_identity: "BLOCKED",
      putaway_destination: "SKIPPED",
      putaway_preflight: "SKIPPED",
      putaway_execute: "SKIPPED",
      putaway_verify: "SKIPPED",
    });

    expect(result.ok).toBe(false);
    // Nothing moved, nothing was recorded, no bin was reserved.
    expect(await prisma.movement.count()).toBe(0);
    expect(await prisma.inventory.count()).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
    expect((await prisma.bin.findMany()).every((bin) => bin.status === "AVAILABLE")).toBe(true);
  });

  it("Test 3 — a confirmed human resolution lets the same scan continue", async () => {
    await createPart(BOLT);
    await createPart(BOLT_FLANGE);
    const scan = boltScan();

    const opened = await requestCatalogResolution(scan);
    expect(opened.status).toBe("HUMAN_DECISION_REQUIRED");
    if (opened.status !== "HUMAN_DECISION_REQUIRED") return;
    const chosen = opened.candidates.find((candidate) => candidate.sku === "BOLT-M8-50")!;
    const confirmed = await confirmCatalogResolution(opened.resolutionId, chosen.partId);
    expect(confirmed.ok).toBe(true);

    const { graph, result } = await runPutawayGraph({
      scanResult: scan,
      catalogResolutionId: opened.resolutionId,
    });

    expect(graph.status).toBe("COMPLETED");
    expect(statuses(graph).putaway_identity).toBe("COMPLETED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Provenance survives the graph: this identity came from a person.
    expect(result.identity.source).toBe("HUMAN_RESOLUTION");
    expect(result.part.sku).toBe("BOLT-M8-50");
    expect(await inventoryTotal("BOLT-M8-50")).toBe(1);

    // The identity step says so in words too, for the operator.
    const step = graph.steps.find((s) => s.nodeId === PUTAWAY_NODE_IDS.identity);
    expect(step?.summary).toContain("confirmed by an operator");
  });

  it("Test 4 — NO_MATCH blocks and no Part is invented", async () => {
    const scan: ScanResult = {
      ...bearingScan("scan_1788574200123_nomatch"),
      object: { detectedName: "hydraulic accumulator", description: "Large steel cylinder." },
      dimensions: { lengthMM: 400, widthMM: 180, heightMM: 180 },
    };

    const { graph } = await runPutawayGraph({ scanResult: scan });

    expect(graph.status).toBe("BLOCKED");
    expect(graph.status === "BLOCKED" && graph.reason).toBe("catalog_no_match");
    expect(statuses(graph).putaway_execute).toBe("SKIPPED");
    expect(await prisma.part.count()).toBe(1);
    expect(await prisma.movement.count()).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
  });

  it("Test 5 — no available bin blocks before execution", async () => {
    for (const code of ["A01", "A02", "A03", "B01", "B02", "B03"]) {
      await setBinStatus(code, "DISABLED");
    }

    const { graph } = await runPutawayGraph({ scanResult: bearingScan() });

    expect(graph.status).toBe("BLOCKED");
    expect(graph.status === "BLOCKED" && graph.reason).toBe("no_available_bin");
    expect(statuses(graph)).toMatchObject({
      putaway_destination: "BLOCKED",
      putaway_preflight: "SKIPPED",
      putaway_execute: "SKIPPED",
    });
    expect(await prisma.movement.count()).toBe(0);
  });

  it("Test 5b — an explicitly requested unavailable bin blocks at destination", async () => {
    await setBinStatus("B03", "DISABLED");

    const { graph } = await runPutawayGraph({
      scanResult: bearingScan(),
      destinationBinCode: "B03",
    });

    expect(graph.status === "BLOCKED" && graph.reason).toBe("bin_unavailable");
    expect(statuses(graph).putaway_execute).toBe("SKIPPED");
    expect(await inventoryTotal("BRG-6204")).toBe(0);
  });

  it("Test 6 — a busy gantry blocks at preflight with no inventory change", async () => {
    // A slow home() keeps the machine occupied across the whole graph run, so
    // the gantry is genuinely busy rather than merely reported as such.
    process.env.GANTRY_SIM_HOME_DELAY_MS = "300";
    resetGantryController();
    const inFlight = getGantryController().home();

    const { graph } = await runPutawayGraph({ scanResult: bearingScan() });

    expect(graph.status).toBe("BLOCKED");
    expect(graph.status === "BLOCKED" && graph.reason).toBe("gantry_busy");
    expect(statuses(graph)).toMatchObject({
      putaway_preflight: "BLOCKED",
      putaway_execute: "SKIPPED",
      putaway_verify: "SKIPPED",
    });
    expect(await inventoryTotal("BRG-6204")).toBe(0);
    expect(await prisma.movement.count()).toBe(0);

    await inFlight;
    process.env.GANTRY_SIM_HOME_DELAY_MS = "0";
    resetGantryController();
  });

  it("Test 7 — a gantry failure fails execute, skips verify, and never retries", async () => {
    simulator().failNextOperation("pickup_failed");

    const { graph, result } = await runPutawayGraph({ scanResult: bearingScan() });

    expect(graph.status).toBe("FAILED");
    expect(graph.status === "FAILED" && graph.reason).toBe("gantry_failed");
    expect(statuses(graph)).toMatchObject({
      putaway_preflight: "COMPLETED",
      putaway_execute: "FAILED",
      putaway_verify: "SKIPPED",
    });

    expect(result.ok).toBe(false);
    // Inventory untouched, the movement recorded as FAILED, the bin released,
    // and — the point — exactly ONE gantry attempt. No loop retried it.
    expect(await inventoryTotal("BRG-6204")).toBe(0);
    const movements = await prisma.movement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0].status).toBe("FAILED");
    expect((await simulator().getRecentOperations()).length).toBe(1);
    expect((await prisma.bin.findMany()).every((bin) => bin.status !== "RESERVED")).toBe(true);
  });

  it("Test 12 — running the same scan twice executes one physical putaway", async () => {
    const scan = bearingScan("scan_1788574200123_idem");

    const first = await runPutawayGraph({ scanResult: scan });
    const second = await runPutawayGraph({ scanResult: scan });

    expect(first.graph.status).toBe("COMPLETED");
    expect(second.graph.status).toBe("COMPLETED");
    expect(first.result.ok && first.result.inventoryQuantityAdded).toBe(1);
    // The replay adds nothing — that is what idempotency means.
    expect(second.result.ok && second.result.inventoryQuantityAdded).toBe(0);
    expect(second.result.ok && second.result.duplicate).toBe(true);

    expect(await inventoryTotal("BRG-6204")).toBe(1);
    expect(await prisma.movement.count()).toBe(1);
    expect((await simulator().getRecentOperations()).length).toBe(1);
  });

  it("Test 13 — concurrent graphs contending for one bin store exactly one item", async () => {
    for (const code of ["A02", "A03", "B01", "B02", "B03"]) {
      await setBinStatus(code, "DISABLED");
    }

    const [a, b] = await Promise.all([
      runPutawayGraph({ scanResult: bearingScan("scan_1788574200123_c1") }),
      runPutawayGraph({ scanResult: bearingScan("scan_1788574200123_c2") }),
    ]);

    const succeeded = [a, b].filter((run) => run.result.ok);
    expect(succeeded).toHaveLength(1);
    expect(await inventoryTotal("BRG-6204")).toBe(1);
    const a01 = await prisma.bin.findUnique({ where: { code: "A01" } });
    expect(a01?.status).toBe("OCCUPIED");
  });

  it("Test 14 — a stale preflight is overruled by the service, not the other way round", async () => {
    for (const code of ["A02", "A03", "B01", "B02", "B03"]) {
      await setBinStatus(code, "DISABLED");
    }

    // A hook on the SDK's own node lifecycle: A01 is taken AFTER preflight
    // approved it and BEFORE the execute node runs.
    const graphInstance = createPutawayGraph();
    graphInstance.addHook(BeforeNodeCallEvent, async (event) => {
      if (event.nodeId === PUTAWAY_NODE_IDS.execute) {
        await setBinStatus("A01", "OCCUPIED");
      }
    });

    const { graph, result } = await runPutawayGraph(
      { scanResult: bearingScan() },
      graphInstance,
    );

    expect(statuses(graph).putaway_preflight).toBe("COMPLETED");
    expect(statuses(graph).putaway_execute).toBe("FAILED");
    expect(graph.status).toBe("FAILED");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The service's fresh read wins. A passed preflight authorises nothing.
    expect(["bin_unavailable", "bin_reservation_conflict", "no_available_bin"]).toContain(
      result.reason,
    );
    expect(await inventoryTotal("BRG-6204")).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
  });
});

/* ----------------------------------------------------------- retrieval */

describe("retrieval graph", () => {
  it("Test 8 — completes every stage and removes exactly one item", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    await setBinStatus("B03", "OCCUPIED");

    const { graph, result } = await runRetrievalGraph({ sku: "BRG-6204", quantity: 1 });

    expect(graph.status).toBe("COMPLETED");
    expect(statuses(graph)).toEqual({
      retrieval_validate: "COMPLETED",
      retrieval_part: "COMPLETED",
      retrieval_inventory: "COMPLETED",
      retrieval_source: "COMPLETED",
      retrieval_preflight: "COMPLETED",
      retrieval_execute: "COMPLETED",
      retrieval_verify: "COMPLETED",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventoryQuantityRemoved).toBe(1);
    expect(result.sourceBinCode).toBe("B03");
    expect(await inventoryTotal("BRG-6204")).toBe(1);
    expect((await simulator().getRecentOperations()).length).toBe(1);
  });

  it("Test 9 — a known part with no stock blocks at the inventory stage", async () => {
    const { graph, result } = await runRetrievalGraph({ sku: "BRG-6204", quantity: 1 });

    expect(graph.status).toBe("BLOCKED");
    expect(graph.status === "BLOCKED" && graph.reason).toBe("out_of_stock");
    expect(statuses(graph)).toMatchObject({
      retrieval_part: "COMPLETED",
      retrieval_inventory: "BLOCKED",
      retrieval_source: "SKIPPED",
      retrieval_execute: "SKIPPED",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.movement.count()).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
  });

  it("Test 9b — an unknown part is a different answer from no stock", async () => {
    const { graph } = await runRetrievalGraph({ sku: "NOT-A-PART", quantity: 1 });

    expect(graph.status === "BLOCKED" && graph.reason).toBe("part_not_found");
    expect(statuses(graph)).toMatchObject({
      retrieval_part: "BLOCKED",
      retrieval_inventory: "SKIPPED",
    });
  });

  it("Test 10 — an explicit source bin that does not hold the part blocks", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    await setBinStatus("B03", "OCCUPIED");

    const { graph, result } = await runRetrievalGraph({
      sku: "BRG-6204",
      sourceBinCode: "A01",
      quantity: 1,
    });

    expect(graph.status === "BLOCKED" && graph.reason).toBe("source_inventory_mismatch");
    expect(statuses(graph)).toMatchObject({
      retrieval_source: "BLOCKED",
      retrieval_preflight: "SKIPPED",
      retrieval_execute: "SKIPPED",
    });
    expect(result.ok).toBe(false);
    expect(await inventoryTotal("BRG-6204")).toBe(1);
  });

  it("Test 10b — refuses a multi-item request outright rather than fetching one", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 3 });
    await setBinStatus("B03", "OCCUPIED");

    const { graph } = await runRetrievalGraph({ sku: "BRG-6204", quantity: 3 });

    expect(graph.status === "BLOCKED" && graph.reason).toBe("unsupported_quantity");
    expect(statuses(graph).retrieval_execute).toBe("SKIPPED");
    expect(await inventoryTotal("BRG-6204")).toBe(3);
  });

  it("Test 11 — a gantry failure leaves inventory untouched and is not retried", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    await setBinStatus("B03", "OCCUPIED");
    simulator().failNextOperation("drop_failed");

    const { graph, result } = await runRetrievalGraph({ sku: "BRG-6204", quantity: 1 });

    expect(graph.status).toBe("FAILED");
    expect(graph.status === "FAILED" && graph.reason).toBe("gantry_failed");
    expect(statuses(graph)).toMatchObject({
      retrieval_execute: "FAILED",
      retrieval_verify: "SKIPPED",
    });
    expect(result.ok).toBe(false);
    // The invariant: stock only ever falls after the machine succeeded.
    expect(await inventoryTotal("BRG-6204")).toBe(2);
    expect((await simulator().getRecentOperations()).length).toBe(1);
  });

  it("Test 12 — the same request id retrieves one item, not two", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    await setBinStatus("B03", "OCCUPIED");

    const first = await runRetrievalGraph({ sku: "BRG-6204", quantity: 1, requestId: "req-idem" });
    const second = await runRetrievalGraph({ sku: "BRG-6204", quantity: 1, requestId: "req-idem" });

    expect(first.result.ok && first.result.inventoryQuantityRemoved).toBe(1);
    expect(second.result.ok && second.result.inventoryQuantityRemoved).toBe(0);
    expect(second.result.ok && second.result.duplicate).toBe(true);
    expect(await inventoryTotal("BRG-6204")).toBe(1);
    expect((await simulator().getRecentOperations()).length).toBe(1);
  });

  it("Test 13 — concurrent graphs racing for the last item never go negative", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    await setBinStatus("B03", "OCCUPIED");

    const [a, b] = await Promise.all([
      runRetrievalGraph({ sku: "BRG-6204", quantity: 1, requestId: "race-a" }),
      runRetrievalGraph({ sku: "BRG-6204", quantity: 1, requestId: "race-b" }),
    ]);

    expect([a, b].filter((run) => run.result.ok)).toHaveLength(1);
    expect(await inventoryTotal("BRG-6204")).toBe(0);
    const rows = await prisma.inventory.findMany();
    expect(rows.every((row) => row.quantity >= 0)).toBe(true);
  });

  it("Test 14 — a stale preflight is overruled by RetrievalService", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 1 });
    await setBinStatus("B03", "OCCUPIED");

    const graphInstance = createRetrievalGraph();
    graphInstance.addHook(BeforeNodeCallEvent, async (event) => {
      if (event.nodeId === RETRIEVAL_NODE_IDS.execute) {
        // Someone else took the last one between preflight and execution.
        const part = await prisma.part.findUnique({ where: { sku: "BRG-6204" } });
        const bin = await prisma.bin.findUnique({ where: { code: "B03" } });
        await prisma.inventory.deleteMany({ where: { partId: part!.id, binId: bin!.id } });
      }
    });

    const { graph, result } = await runRetrievalGraph(
      { sku: "BRG-6204", quantity: 1 },
      graphInstance,
    );

    expect(statuses(graph).retrieval_preflight).toBe("COMPLETED");
    expect(statuses(graph).retrieval_execute).toBe("FAILED");
    expect(result.ok).toBe(false);
    expect(await inventoryTotal("BRG-6204")).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
  });
});

/* ------------------------------------------------- agent + HITL + graph */

describe("graphs behind the agent and the approval gate", () => {
  it("Test 15 — a denied approval never runs the putaway graph", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Done.")];

    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-deny",
      null,
      scripted(turns),
    );
    expect(paused.status).toBe("APPROVAL_REQUIRED");
    // Parked, so nothing has run — not even the read-only graph stages.
    expect(paused.workflows).toBeUndefined();

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "DENY",
      scripted(turns),
    );

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.reply.workflows).toBeUndefined();
    expect(await prisma.movement.count()).toBe(0);
    expect(await prisma.inventory.count()).toBe(0);
    expect(await simulator().getRecentOperations()).toEqual([]);
  });

  it("Test 15b — an approved putaway runs the graph and reports its steps", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Stored.")];

    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-approve",
      null,
      scripted(turns),
    );
    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      scripted(turns),
    );

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const workflows = resumed.reply.workflows;
    expect(workflows).toHaveLength(1);
    expect(workflows![0].workflow).toBe("PUTAWAY");
    expect(workflows![0].status).toBe("COMPLETED");
    expect(workflows![0].steps.map((step) => step.nodeId)).toEqual([...PUTAWAY_NODE_ORDER]);
    expect(await inventoryTotal("BRG-6204")).toBe(1);
  });

  it("Test 16 — a read-only question runs no graph at all", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const turns = [
      toolUseTurn("search_inventory", "tool-1", JSON.stringify({ query: "BRG-6204" })),
      textTurn("BRG-6204 is in B03."),
    ];

    const reply = await invokeWarehouseAgent(
      "Where is BRG-6204?",
      undefined,
      "req-read",
      null,
      scripted(turns),
    );

    expect(reply.status).toBe("COMPLETED");
    expect(reply.toolCalls).toEqual(["search_inventory"]);
    expect(reply.workflows).toBeUndefined();
    expect(await prisma.movement.count()).toBe(0);
  });
});

/* ------------------------------------------------------- safe results */

describe("graph result contract", () => {
  it("carries no reasoning, prompts, credentials or raw SDK objects", async () => {
    const { graph } = await runPutawayGraph({ scanResult: bearingScan() });
    const serialized = JSON.stringify(graph);

    // Round-trips as plain JSON — no class instances leak to a client.
    expect(JSON.parse(serialized)).toEqual(graph);
    for (const forbidden of [
      "thinking",
      "systemPrompt",
      "AWS_",
      "accessKey",
      "data:image",
      "reasoning",
      "modelId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const step of graph.steps) {
      expect(Object.keys(step).sort()).toEqual(
        expect.arrayContaining(["label", "nodeId", "status"]),
      );
    }
  });
});
