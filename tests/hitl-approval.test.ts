import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { createPart } from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { SimulatedGantryController } from "@/lib/gantry/simulator";
import {
  DENIED_REPLY,
  createWarehouseAgent,
  invokeWarehouseAgent,
  parseInterruptReason,
  resumeWarehouseAgent,
} from "@/lib/agents/warehouse-agent";
import {
  confirmCatalogResolution,
  requestCatalogResolution,
} from "@/lib/warehouse/catalog-resolution-service";
import { APPROVAL_FREE_TOOL_NAMES, APPROVAL_REQUIRED_TOOL_NAMES } from "@/lib/agents/tools";
import { clearPendingApprovals } from "@/lib/agents/approval-store";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { ScriptedModel, textTurn, toolUseTurn } from "./scripted-model";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 9 approval gate, driven through the REAL agent, the REAL tool list
 * and the REAL HumanInTheLoop configuration — only the model is scripted, so
 * these assert the interception and resume mechanics rather than whether a
 * particular LLM behaves.
 *
 * The question every test here answers is the same: can warehouse state change
 * before a person said yes?
 */

const BEARING_6204 = {
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 20mm bore",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};

function scanOf(overrides: Partial<{ scanId: string }> = {}): ScanResult {
  return {
    scanId: overrides.scanId ?? "scan_1788574200123_hitl",
    capturedAt: 1788574200123,
    object: { detectedName: "6204 bearing", description: "Metal circular bearing." },
    dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

/** Builds an agent factory whose model replays the given turns. */
const scripted = (turns: ReturnType<typeof textTurn>[]) => () =>
  createWarehouseAgent(new ScriptedModel(turns));

const simulator = () => getGantryController() as SimulatedGantryController;

async function warehouseState() {
  const [parts, bins, inventory, movements] = await Promise.all([
    prisma.part.findMany({ orderBy: { sku: "asc" } }),
    prisma.bin.findMany({ orderBy: { code: "asc" } }),
    prisma.inventory.findMany({ orderBy: { id: "asc" } }),
    prisma.movement.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { parts, bins, inventory, movements };
}

beforeEach(async () => {
  await resetWarehouse();
  resetGantryController();
  clearPendingApprovals();
  await prisma.actionApproval.deleteMany();
  await createPart(BEARING_6204);
});

/* ------------------------------------------------------------- policy */

describe("approval policy", () => {
  it("splits tools into approval-free and approval-required, with no overlap", () => {
    expect([...APPROVAL_FREE_TOOL_NAMES]).toEqual([
      "get_gantry_status",
      "search_catalog",
      "get_part",
      "search_inventory",
      "get_bin_status",
      "list_available_bins",
      "match_catalog",
    ]);
    expect([...APPROVAL_REQUIRED_TOOL_NAMES]).toEqual(["execute_putaway", "execute_retrieval"]);

    const free = new Set<string>(APPROVAL_FREE_TOOL_NAMES);
    for (const name of APPROVAL_REQUIRED_TOOL_NAMES) expect(free.has(name)).toBe(false);
  });
});

/* ---------------------------------------------------------- read-only */

describe("read-only tools", () => {
  it("run immediately, with no approval requested", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });

    const reply = await invokeWarehouseAgent(
      "Where is BRG-6204?",
      undefined,
      "req-read",
      null,
      scripted([
        toolUseTurn("search_inventory", "t1", '{"query":"BRG-6204"}'),
        textTurn("It is in B2-01."),
      ]),
    );

    expect(reply.status).toBe("COMPLETED");
    expect(reply.approval).toBeUndefined();
    expect(reply.toolCalls).toContain("search_inventory");
    expect(await prisma.actionApproval.count()).toBe(0);
  });
});

/* --------------------------------------------------------- retrieval */

describe("retrieval approval", () => {
  const retrievalTurns = () => [
    toolUseTurn("execute_retrieval", "t-ret", '{"sku":"BRG-6204","quantity":1}'),
    textTurn("Retrieved."),
  ];

  it("pauses before executing, changing nothing", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const before = await warehouseState();

    const reply = await invokeWarehouseAgent(
      "Bring me BRG-6204.",
      undefined,
      "req-ret",
      null,
      scripted(retrievalTurns()),
    );

    expect(reply.status).toBe("APPROVAL_REQUIRED");
    expect(reply.approval?.approvalId).toMatch(/^approval_/);
    expect(reply.approval?.action).toBe("execute_retrieval");
    expect(reply.approval?.summary).toMatchObject({
      action: "RETRIEVAL",
      sku: "BRG-6204",
      destination: "OUTPUT",
      quantity: 1,
    });

    // Nothing happened.
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
    const audit = await prisma.actionApproval.findUniqueOrThrow({
      where: { id: reply.approval!.approvalId },
    });
    expect(audit.status).toBe("PENDING");
  });

  it("executes exactly once when approved", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const turns = retrievalTurns();
    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-ok", null, scripted(turns),
    );

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId, "APPROVE", scripted(turns),
    );

    expect(resumed.ok).toBe(true);
    const inventory = await prisma.inventory.findMany();
    expect(inventory).toHaveLength(1);
    expect(inventory[0].quantity).toBe(1); // 2 -> 1, exactly once
    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].type).toBe("RETRIEVAL");

    const audit = await prisma.actionApproval.findUniqueOrThrow({
      where: { id: paused.approval!.approvalId },
    });
    expect(audit.status).toBe("APPROVED");
    expect(audit.resolvedAt).not.toBeNull();
  });

  it("executes nothing when denied", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const turns = retrievalTurns();
    const before = await warehouseState();

    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-no", null, scripted(turns),
    );
    await resumeWarehouseAgent(paused.approval!.approvalId, "DENY", scripted(turns));

    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
    expect(
      (await prisma.actionApproval.findUniqueOrThrow({ where: { id: paused.approval!.approvalId } }))
        .status,
    ).toBe("DENIED");
  });

  it("reports a denial in fixed words, never the model's", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    // The scripted model would say "Retrieved." — which must not be shown.
    const turns = retrievalTurns();
    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-words", null, scripted(turns),
    );
    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId, "DENY", scripted(turns),
    );

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.reply.message).toBe(DENIED_REPLY);
    expect(resumed.reply.message).not.toMatch(/try again|retrieved/i);
    // The scripted model immediately asks again after the denial. No second
    // approval may be opened for it — that is the harassment the operator
    // just refused.
    expect(resumed.reply.status).toBe("COMPLETED");
    expect(resumed.reply.approval).toBeUndefined();
    expect(await prisma.actionApproval.count()).toBe(1);
  });

  it("refuses to approve something already denied", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const turns = retrievalTurns();
    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-flip", null, scripted(turns),
    );

    await resumeWarehouseAgent(paused.approval!.approvalId, "DENY", scripted(turns));
    const second = await resumeWarehouseAgent(
      paused.approval!.approvalId, "APPROVE", scripted(turns),
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("approval_not_pending");
    expect(await prisma.inventory.count()).toBe(1);
    expect((await prisma.inventory.findMany())[0].quantity).toBe(2); // untouched
  });

  it("is idempotent when approved twice", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const turns = retrievalTurns();
    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-twice", null, scripted(turns),
    );

    const first = await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));
    const second = await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false); // already settled
    expect((await prisma.inventory.findMany())[0].quantity).toBe(1); // one decrement only
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });

  it("never executes an expired approval", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 2 });
    const turns = retrievalTurns();
    const before = await warehouseState();
    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.", undefined, "req-ret-exp", null, scripted(turns),
    );

    // Age it past its TTL.
    await prisma.actionApproval.update({
      where: { id: paused.approval!.approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId, "APPROVE", scripted(turns),
    );

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.reason).toBe("approval_expired");
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
    expect(
      (await prisma.actionApproval.findUniqueOrThrow({ where: { id: paused.approval!.approvalId } }))
        .status,
    ).toBe("EXPIRED");
  });

  it("rejects an unknown approval id", async () => {
    const resumed = await resumeWarehouseAgent("approval_does_not_exist", "APPROVE", scripted([]));
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.reason).toBe("approval_not_found");
  });
});

/* ----------------------------------------------------------- putaway */

describe("putaway approval", () => {
  const putawayTurns = () => [
    toolUseTurn("execute_putaway", "t-put", '{"destinationBinCode":"B2-01"}'),
    textTurn("Stored."),
  ];

  it("pauses before storing anything", async () => {
    const before = await warehouseState();
    const reply = await invokeWarehouseAgent(
      "Store this scanned part.", scanOf(), "req-put", null, scripted(putawayTurns()),
    );

    expect(reply.status).toBe("APPROVAL_REQUIRED");
    expect(reply.approval?.summary).toMatchObject({
      action: "PUTAWAY",
      sku: "BRG-6204",
      source: "INTAKE",
      destination: "B2-01",
    });
    expect(await warehouseState()).toEqual(before);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("executes exactly once when approved", async () => {
    const turns = putawayTurns();
    const paused = await invokeWarehouseAgent(
      "Store this scanned part.", scanOf(), "req-put-ok", null, scripted(turns),
    );
    await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));

    const inventory = await prisma.inventory.findMany({ include: { bin: true } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].bin.code).toBe("B2-01");
    expect(inventory[0].quantity).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });

  it("revalidates the world after approval — a stale card cannot force a putaway", async () => {
    // The approval card says B2-01. Between the card and the decision, B2-01 fills.
    const turns = putawayTurns();
    const paused = await invokeWarehouseAgent(
      "Store this scanned part.", scanOf(), "req-put-stale", null, scripted(turns),
    );
    expect(paused.approval?.summary.destination).toBe("B2-01");

    await addInventory({ sku: "BRG-6204", binCode: "B2-01", quantity: 1 }); // B2-01 -> OCCUPIED

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId, "APPROVE", scripted(turns),
    );
    expect(resumed.ok).toBe(true);

    // The putaway was refused by the service, not waved through by the approval.
    expect(await prisma.inventory.count()).toBe(1);
    expect((await prisma.inventory.findMany())[0].quantity).toBe(1);
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("approval is not success — a gantry failure after approval leaves stock alone", async () => {
    const turns = putawayTurns();
    const paused = await invokeWarehouseAgent(
      "Store this scanned part.", scanOf(), "req-put-fail", null, scripted(turns),
    );
    simulator().failNextOperation("pickup_failed");

    await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));

    expect(await prisma.inventory.count()).toBe(0);
    expect(await setBinStatusUnchanged()).toBe(true);
    const movement = await prisma.movement.findFirstOrThrow();
    expect(movement.status).toBe("FAILED");
    // The decision still reads APPROVED: approving and succeeding are different.
    expect(
      (await prisma.actionApproval.findUniqueOrThrow({ where: { id: paused.approval!.approvalId } }))
        .status,
    ).toBe("APPROVED");
  });
});

async function setBinStatusUnchanged(): Promise<boolean> {
  const bin = await prisma.bin.findUniqueOrThrow({ where: { code: "B2-01" } });
  return bin.status === "AVAILABLE";
}

/* -------------------------------------------------- argument binding */

describe("approval binding", () => {
  it("cannot be redirected to a different bin", async () => {
    // The approval API takes only an id and a decision — there is no argument
    // channel to change B2-01 into B1-02. This asserts the frozen arguments are
    // what actually execute.
    const turns = [
      toolUseTurn("execute_putaway", "t-bind", '{"destinationBinCode":"B2-01"}'),
      textTurn("Stored."),
    ];
    const paused = await invokeWarehouseAgent(
      "Store this scanned part.", scanOf(), "req-bind", null, scripted(turns),
    );
    expect(paused.approval?.summary.destination).toBe("B2-01");

    await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));

    const inventory = await prisma.inventory.findMany({ include: { bin: true } });
    expect(inventory[0].bin.code).toBe("B2-01");
    expect(await prisma.bin.findUniqueOrThrow({ where: { code: "B1-02" } })).toMatchObject({
      status: "AVAILABLE",
    });
  });
});

/* ------------------------------------------------- interrupt parsing */

describe("interrupt reason parsing", () => {
  it("still understands the SDK's approval prompt format", async () => {
    // The summary card depends on this format. If an SDK upgrade changes it,
    // fail loudly here rather than quietly showing "unknown_tool" to operators.
    // Execution never depends on it — the arguments that run come from the
    // Strands snapshot — so this is a UI-fidelity guard, not a safety one.
    const agent = createWarehouseAgent(
      new ScriptedModel([
        toolUseTurn("execute_retrieval", "t-parse", '{"sku":"BRG-6204","quantity":1}'),
        textTurn("done"),
      ]),
    );
    const result = await agent.invoke("Bring me BRG-6204.");
    expect(result.stopReason).toBe("interrupt");

    const parsed = parseInterruptReason(result.interrupts![0].reason);
    expect(parsed).toEqual({
      name: "execute_retrieval",
      input: { sku: "BRG-6204", quantity: 1 },
    });
  });

  it("degrades safely on an unrecognised format", () => {
    expect(parseInterruptReason("something else entirely")).toBeNull();
    expect(parseInterruptReason(undefined)).toBeNull();
    expect(parseInterruptReason('Approve "x"?\n  Input: not json')).toEqual({
      name: "x",
      input: null,
    });
  });
});

/* --------------------------------------- ambiguous putaway, end to end */

describe("ambiguous scan through both gates", () => {
  const BOLT_HEX = {
    sku: "BOLT-M8-50", canonicalName: "M8 x 50 Hex Bolt", category: "fastener",
    description: "Zinc-plated steel hex head bolt", lengthMM: 50, widthMM: 13, heightMM: 5.3,
  };
  const BOLT_FLANGE = {
    sku: "BOLT-M8-50-FLG", canonicalName: "M8 x 50 Flange Bolt", category: "fastener",
    description: "Zinc-plated steel flange head bolt", lengthMM: 50, widthMM: 14, heightMM: 5.3,
  };
  const ambiguous: ScanResult = {
    scanId: "scan_1788574200123_e2e",
    capturedAt: 1788574200123,
    object: { detectedName: "M8 bolt", description: "Steel hex bolt" },
    dimensions: { lengthMM: 50.1, widthMM: 13.5, heightMM: 5.3 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };

  it("needs identity resolution AND action approval, in that order", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const turns = [
      toolUseTurn("execute_putaway", "t-e2e", '{"destinationBinCode":"B2-01"}'),
      textTurn("Stored."),
    ];

    /* GATE 0 — without a resolution the agent cannot get past the matcher. */
    const blocked = await invokeWarehouseAgent(
      "Store this scanned part.", ambiguous, "req-e2e-blocked", null, scripted(turns),
    );
    expect(blocked.status).toBe("APPROVAL_REQUIRED");
    const blockedResume = await resumeWarehouseAgent(
      blocked.approval!.approvalId, "APPROVE", scripted(turns),
    );
    expect(blockedResume.ok).toBe(true);
    // Approved, yet nothing stored: identity was never resolved.
    expect(await prisma.inventory.count()).toBe(0);
    expect(await getGantryController().getRecentOperations()).toEqual([]);

    /* GATE 1 — a person identifies the part. */
    const request = await requestCatalogResolution(ambiguous);
    expect(request.status).toBe("HUMAN_DECISION_REQUIRED");
    if (request.status !== "HUMAN_DECISION_REQUIRED") return;
    const chosen = request.candidates.find((c) => c.sku === "BOLT-M8-50")!;
    const confirmed = await confirmCatalogResolution(request.resolutionId, chosen.partId);
    expect(confirmed.ok).toBe(true);
    // Identifying a part moves nothing.
    expect(await getGantryController().getRecentOperations()).toEqual([]);

    /* GATE 2 — the physical action still needs its own approval. */
    const paused = await invokeWarehouseAgent(
      "Store this scanned part.", ambiguous, "req-e2e", request.resolutionId, scripted(turns),
    );
    expect(paused.status).toBe("APPROVAL_REQUIRED");
    expect(await prisma.inventory.count()).toBe(0);

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId, "APPROVE", scripted(turns),
    );
    expect(resumed.ok).toBe(true);

    /* Only now does anything move. */
    const inventory = await prisma.inventory.findMany({ include: { bin: true, part: true } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].part.sku).toBe("BOLT-M8-50");
    expect(inventory[0].bin.code).toBe("B2-01");
    expect(inventory[0].quantity).toBe(1);

    const operations = await getGantryController().getRecentOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("COMPLETED");

    const movement = await prisma.movement.findFirstOrThrow({ where: { status: "COMPLETED" } });
    expect(movement.type).toBe("PUTAWAY");
    expect(movement.scanId).toBe(ambiguous.scanId);
  });
});
