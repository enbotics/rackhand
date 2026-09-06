import { beforeEach, describe, expect, it } from "vitest";
import { AfterToolCallEvent, BeforeToolCallEvent } from "@strands-agents/sdk";
import { prisma } from "@/lib/warehouse/db";
import { createPart, setBinStatus } from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { SimulatedGantryController } from "@/lib/gantry/simulator";
import {
  createWarehouseAgent,
  invokeWarehouseAgent,
  resumeWarehouseAgent,
} from "@/lib/agents/warehouse-agent";
import { clearPendingApprovals } from "@/lib/agents/approval-store";
import {
  requestCatalogResolution,
  confirmCatalogResolution,
} from "@/lib/warehouse/catalog-resolution-service";
import {
  catalogResolutionTraceId,
  clearTraceSequenceCache,
  getTrace,
  listTraces,
  pruneTraces,
  recordEvent,
  startTrace,
} from "@/lib/observability/trace-service";
import {
  MAX_REQUEST_SUMMARY_LENGTH,
  REDACTED,
  sanitizeMetadata,
  sanitizeRequestSummary,
  sanitizeScanResult,
} from "@/lib/observability/sanitize";
import { attachTraceHooks, clearToolTimings } from "@/lib/observability/strands-hooks";
import type { TraceView } from "@/lib/observability/types";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { ScriptedModel, textTurn, toolUseTurn } from "./scripted-model";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 12 — the trace layer.
 *
 * Two questions run through everything here:
 *
 *  1. Does the timeline tell the truth? An inventory event that appears when
 *     nothing moved, or a gantry success after a pickup failure, is worse than
 *     no trace at all — it would let a judge, or an operator, believe the
 *     warehouse did something it did not.
 *  2. Is it safe? Observability sits closest to the model's private state and
 *     to the process's secrets, so it is the layer most able to leak them, and
 *     the one most tempting to let "just retry that tool".
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
const BOLT = {
  sku: "BOLT-M8-50",
  canonicalName: "M8 x 50 Hex Bolt",
  category: "fastener",
  lengthMM: 50,
  widthMM: 13,
  heightMM: 5.3,
};
const BOLT_FLANGE = {
  sku: "BOLT-M8-50-FLG",
  canonicalName: "M8 x 50 Flange Bolt",
  category: "fastener",
  lengthMM: 50,
  widthMM: 14,
  heightMM: 5.3,
};

function bearingScan(scanId = "scan_1788574200123_obs"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200123,
    object: { detectedName: "6204 bearing", description: "Metal circular bearing." },
    dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

function boltScan(scanId = "scan_1788574200999_obs"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200999,
    object: { detectedName: "m8 hex bolt", description: "Steel bolt with hex head." },
    dimensions: { lengthMM: 50.2, widthMM: 13.4, heightMM: 5.3 },
    quality: { dimensionConfidence: 0.94, calibrationRmsPixels: 1.2 },
    orientation: { angleDegrees: 8 },
  };
}

/**
 * Makes a Prisma model method reject, then puts it back exactly as it was.
 *
 * `vi.spyOn` cannot be used here: Prisma reaches model methods through a proxy
 * trap rather than an own property, so `mockRestore()` leaves the method
 * `undefined` and quietly breaks every later test in the file. Saving and
 * reassigning the original reference is the only restore that actually works.
 */
function breakPrismaMethod<T extends object, K extends keyof T>(
  model: T,
  method: K,
  failure: Error,
): { undo: () => void; calls: number } {
  const original = model[method];
  const state = { undo: () => {}, calls: 0 };
  model[method] = ((...args: unknown[]) => {
    state.calls += 1;
    void args;
    return Promise.reject(failure);
  }) as T[K];
  state.undo = () => {
    model[method] = original;
  };
  return state;
}

const scripted = (turns: ReturnType<typeof textTurn>[]) => () =>
  createWarehouseAgent(new ScriptedModel(turns));
const simulator = () => getGantryController() as SimulatedGantryController;

const types = (trace: TraceView) => trace.events.map((event) => event.type);
const named = (trace: TraceView, type: string) =>
  trace.events.filter((event) => event.type === type);

async function traceOf(traceId: string): Promise<TraceView> {
  const trace = await getTrace(traceId);
  expect(trace, `trace ${traceId} should exist`).not.toBeNull();
  return trace!;
}

beforeEach(async () => {
  await resetWarehouse();
  resetGantryController();
  clearPendingApprovals();
  clearTraceSequenceCache();
  clearToolTimings();
  await createPart(BEARING);
});

/* ------------------------------------------------------ trace lifecycle */

describe("trace lifecycle", () => {
  it("Test 1 — opens a trace with a unique id and a start time", async () => {
    const first = await startTrace({ requestSummary: "Where is BRG-6204?" });
    const second = await startTrace({ requestSummary: "Where is BRG-6205?" });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^trace_/);

    const trace = await traceOf(first);
    expect(trace.status).toBe("RUNNING");
    expect(trace.requestSummary).toBe("Where is BRG-6204?");
    expect(Date.parse(trace.startedAt)).toBeGreaterThan(0);
    expect(trace.completedAt).toBeNull();
  });

  it("orders events by a stored sequence rather than by row order", async () => {
    const traceId = await startTrace({ requestSummary: "ordering" });
    for (const name of ["a", "b", "c", "d"]) {
      await recordEvent(traceId, {
        type: "TOOL_COMPLETED",
        status: "COMPLETED",
        name,
        summary: `${name} ran`,
      });
    }

    const trace = await traceOf(traceId);
    expect(trace.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(trace.events.map((event) => event.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("Test 15 — concurrent requests get separate traces that do not mix", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const turns = () => [
      toolUseTurn("search_inventory", "tool-x", JSON.stringify({ query: "BRG-6204" })),
      textTurn("In B03."),
    ];

    const [a, b] = await Promise.all([
      invokeWarehouseAgent("Where is BRG-6204?", undefined, "req-a", null, scripted(turns())),
      invokeWarehouseAgent("How many BRG-6204?", undefined, "req-b", null, scripted(turns())),
    ]);

    expect(a.traceId).not.toBe(b.traceId);
    const [traceA, traceB] = await Promise.all([traceOf(a.traceId), traceOf(b.traceId)]);
    expect(traceA.requestSummary).toBe("Where is BRG-6204?");
    expect(traceB.requestSummary).toBe("How many BRG-6204?");
    // Every event belongs to exactly one timeline.
    expect(traceA.events.length).toBeGreaterThan(0);
    expect(traceB.events.length).toBeGreaterThan(0);
    for (const trace of [traceA, traceB]) {
      expect(trace.events.map((event) => event.sequence)).toEqual(
        trace.events.map((_, index) => index + 1),
      );
    }
  });

  it("keeps the newest traces and drops the rest when pruned", async () => {
    for (let index = 0; index < 6; index += 1) {
      await startTrace({ requestSummary: `run ${index}` });
    }
    const removed = await pruneTraces(3);

    expect(removed).toBe(3);
    expect(await listTraces({ limit: 50 })).toHaveLength(3);
  });
});

/* ------------------------------------------------------- sanitization */

describe("sanitization", () => {
  it("Test 4 — redacts secrets by key and by value shape", async () => {
    const traceId = await startTrace({ requestSummary: "secret check" });
    await recordEvent(traceId, {
      type: "TOOL_COMPLETED",
      status: "COMPLETED",
      name: "search_inventory",
      summary: "ok",
      metadata: {
        sku: "BRG-6204",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        GEMINI_API_KEY: "AIzaSyD-EXAMPLE-key-value-1234567890",
        authorization: "Bearer abc.def.ghi",
        cookie: "session=deadbeef",
        databaseUrl: "file:./prisma/dev.db",
        // An innocent key hiding a credential — caught by value, not by name.
        note: "AKIAIOSFODNN7EXAMPLE",
      },
    });

    const trace = await traceOf(traceId);
    const serialized = JSON.stringify(trace);
    for (const secret of [
      "wJalrXUtnFEMI",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyD-EXAMPLE",
      "abc.def.ghi",
      "deadbeef",
      "file:./prisma/dev.db",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // The useful fact survives.
    expect(trace.events[0].metadata?.sku).toBe("BRG-6204");
    expect(trace.events[0].metadata?.note).toBe(REDACTED);
  });

  it("Test 5 — never persists image bytes, under any key", async () => {
    const base64 = `data:image/jpeg;base64,${"A".repeat(400)}`;
    const traceId = await startTrace({ requestSummary: "image check" });
    await recordEvent(traceId, {
      type: "TOOL_STARTED",
      status: "STARTED",
      name: "execute_putaway",
      summary: "requested",
      metadata: { imageDataUrl: base64, frame: base64, dataUrl: base64, scanId: "scan_1" },
    });

    const stored = await prisma.traceEvent.findFirst({ where: { traceId } });
    expect(stored?.metadataJson).not.toContain("data:image");
    expect(stored?.metadataJson).not.toContain("AAAA");
    expect(stored?.metadataJson).toContain("scan_1");
  });

  it("drops nested structures rather than trying to walk them", () => {
    const sanitized = sanitizeMetadata({
      sku: "BRG-6204",
      nested: { secret: "value", deeper: { credential: "x" } },
      list: ["A01", "B03"],
    });
    expect(sanitized).toEqual({ sku: "BRG-6204", list: "A01, B03" });
  });

  it("bounds the stored request to a documented length", () => {
    const long = "x".repeat(MAX_REQUEST_SUMMARY_LENGTH + 200);
    const summary = sanitizeRequestSummary(long);
    expect(summary.length).toBeLessThanOrEqual(MAX_REQUEST_SUMMARY_LENGTH);
    expect(sanitizeRequestSummary("")).toBe("(no request text)");
  });

  it("reduces a scan to measurement facts, never the frame", () => {
    const sanitized = sanitizeScanResult(bearingScan());
    expect(sanitized).toMatchObject({
      scanId: "scan_1788574200123_obs",
      detectedName: "6204 bearing",
      dimensionConfidence: 0.96,
      calibrationRmsPixels: 1.7,
    });
    expect(JSON.stringify(sanitized)).not.toContain("data:");
  });
});

/* ------------------------------------------------------------ tool trace */

describe("tool tracing through Strands hooks", () => {
  it("Test 2 and 6 — a read-only request traces the tool and nothing else", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const reply = await invokeWarehouseAgent(
      "Where is BRG-6204?",
      undefined,
      "req-read",
      null,
      scripted([
        toolUseTurn("search_inventory", "tool-1", JSON.stringify({ query: "BRG-6204" })),
        textTurn("BRG-6204 is in B03."),
      ]),
    );

    const trace = await traceOf(reply.traceId);
    expect(trace.status).toBe("COMPLETED");
    expect(types(trace)).toEqual([
      "AGENT_STARTED",
      "TOOL_STARTED",
      "TOOL_COMPLETED",
      "AGENT_COMPLETED",
    ]);

    // The SDK's own correlation id links the pair; nothing local is invented.
    const startedId = trace.events[1].metadata?.toolUseId;
    expect(startedId).toBe("tool-1");
    expect(trace.events[2].metadata?.toolUseId).toBe("tool-1");
    expect(trace.events[2].durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.events[2].summary).toContain("BRG-6204");

    // A read-only question invents no physical activity.
    for (const forbidden of [
      "GRAPH_STARTED",
      "MOVEMENT_COMPLETED",
      "GANTRY_COMPLETED",
      "INVENTORY_UPDATED",
      "APPROVAL_REQUIRED",
    ]) {
      expect(types(trace)).not.toContain(forbidden);
    }
  });

  it("Test 3 — a failing tool is recorded without leaking a stack trace", async () => {
    // A bin code the tool will reject, so the failure is real rather than mocked.
    const reply = await invokeWarehouseAgent(
      "What is in bin ZZZ?",
      undefined,
      "req-toolfail",
      null,
      scripted([
        toolUseTurn("get_bin_status", "tool-1", JSON.stringify({ binCode: "ZZZ" })),
        textTurn("No such bin."),
      ]),
    );

    const trace = await traceOf(reply.traceId);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("at Object.");
    expect(serialized).not.toContain(".ts:");
    expect(serialized).not.toContain("node_modules");
    // Either outcome is legitimate — what matters is that no stack escaped.
    expect(types(trace).some((type) => type.startsWith("TOOL_"))).toBe(true);
  });

  it("Test 39-41 — the hooks are passive: no cancel, no swap, no retry", async () => {
    // Capture exactly the callbacks attachTraceHooks registers, then run them
    // against real event objects and assert they changed nothing.
    const callbacks = new Map<string, (event: unknown) => unknown>();
    const stub = {
      addHook(eventType: { name: string }, callback: (event: unknown) => unknown) {
        callbacks.set(eventType.name, callback);
        return () => {};
      },
    };
    attachTraceHooks(stub as never);
    expect([...callbacks.keys()].sort()).toEqual(["AfterToolCallEvent", "BeforeToolCallEvent"]);

    const traceId = await startTrace({ requestSummary: "passivity" });
    const toolUse = { name: "search_inventory", toolUseId: "t1", input: { query: "x" } };
    const invocationState = { warehouseTraceId: traceId };

    const before = new BeforeToolCallEvent({
      agent: null as never,
      toolUse: { ...toolUse },
      tool: undefined,
      invocationState,
    });
    await callbacks.get("BeforeToolCallEvent")!(before);
    expect(before.cancel).toBe(false);
    expect(before.selectedTool).toBeUndefined();
    // The input the tool will receive is untouched.
    expect(before.toolUse).toEqual(toolUse);

    const result = {
      type: "toolResultBlock",
      toolUseId: "t1",
      status: "success",
      content: [{ type: "jsonBlock", json: { found: true, part: { sku: "BRG-6204" }, totalQuantity: 2 } }],
    };
    const after = new AfterToolCallEvent({
      agent: null as never,
      toolUse: { ...toolUse },
      tool: undefined,
      result: result as never,
      invocationState,
    });
    await callbacks.get("AfterToolCallEvent")!(after);
    // The single most important assertion in this file: a logging layer must
    // never cause a physical operation to run a second time.
    expect(after.retry).toBeUndefined();
    expect(after.result).toBe(result);

    // It did, however, observe.
    const trace = await traceOf(traceId);
    expect(types(trace)).toEqual(["TOOL_STARTED", "TOOL_COMPLETED"]);
  });
});

/* -------------------------------------------------- approval + workflow */

describe("approval and workflow traces", () => {
  it("Test 7 and 16 — an approved putaway is one trace, fully correlated", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Stored.")];

    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-put",
      null,
      scripted(turns),
    );
    expect(paused.status).toBe("APPROVAL_REQUIRED");

    const waiting = await traceOf(paused.traceId);
    expect(waiting.status).toBe("WAITING_FOR_APPROVAL");
    expect(types(waiting)).toContain("APPROVAL_REQUIRED");
    // Nothing executed while parked.
    expect(types(waiting)).not.toContain("INVENTORY_UPDATED");

    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      // A real model answers with text once it has the tool result; the script
      // has to do the same or the agent parks on a second identical call.
      scripted([textTurn("Stored.")]),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    // THE SAME TRACE. Clicking approve continues a timeline, it does not begin
    // a second one.
    expect(resumed.reply.traceId).toBe(paused.traceId);
    expect(await prisma.agentTrace.count()).toBe(1);

    const trace = await traceOf(paused.traceId);
    expect(trace.status).toBe("COMPLETED");
    expect(types(trace)).toEqual(
      expect.arrayContaining([
        "AGENT_STARTED",
        "APPROVAL_REQUIRED",
        "APPROVAL_APPROVED",
        "GRAPH_STARTED",
        "GRAPH_STEP_COMPLETED",
        "MOVEMENT_COMPLETED",
        "GANTRY_COMPLETED",
        "INVENTORY_UPDATED",
        "GRAPH_COMPLETED",
        "TOOL_COMPLETED",
        "AGENT_COMPLETED",
      ]),
    );

    // Correlation ids reach the timeline from the authoritative records.
    const movement = await prisma.movement.findFirst();
    expect(named(trace, "MOVEMENT_COMPLETED")[0].metadata?.movementId).toBe(movement!.id);
    const gantry = named(trace, "GANTRY_COMPLETED")[0];
    expect(gantry.metadata?.gantryOperationId).toBe(movement!.gantryOperationId);
    expect(gantry.durationMs).toBeGreaterThanOrEqual(0);
    expect(named(trace, "GRAPH_STARTED")[0].metadata?.graphRunId).toBeTruthy();
    expect(named(trace, "APPROVAL_APPROVED")[0].metadata?.approvalId).toBe(
      paused.approval!.approvalId,
    );
    // The human decision was timed, and separately from model latency.
    expect(named(trace, "APPROVAL_APPROVED")[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(named(trace, "INVENTORY_UPDATED")[0].metadata).toMatchObject({
      sku: "BRG-6204",
      delta: 1,
    });

    // Graph steps appear in execution order.
    const steps = trace.events
      .filter((event) => event.type.startsWith("GRAPH_STEP"))
      .map((event) => event.name);
    expect(steps).toEqual([
      "putaway_validate",
      "putaway_identity",
      "putaway_destination",
      "putaway_preflight",
      "putaway_execute",
      "putaway_verify",
    ]);
  });

  it("Test 8 — an approved retrieval traces the decrement once", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    await setBinStatus("B03", "OCCUPIED");
    const turns = [
      toolUseTurn(
        "execute_retrieval",
        "tool-1",
        JSON.stringify({ sku: "BRG-6204", quantity: 1 }),
      ),
      textTurn("Retrieved."),
    ];

    const paused = await invokeWarehouseAgent(
      "Bring me BRG-6204.",
      undefined,
      "req-ret",
      null,
      scripted(turns),
    );
    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      scripted([textTurn("Retrieved.")]),
    );
    expect(resumed.ok).toBe(true);

    const trace = await traceOf(paused.traceId);
    expect(trace.status).toBe("COMPLETED");
    const inventory = named(trace, "INVENTORY_UPDATED");
    expect(inventory).toHaveLength(1);
    expect(inventory[0].metadata).toMatchObject({ sku: "BRG-6204", delta: -1, remaining: 1 });
    expect(named(trace, "GANTRY_COMPLETED")).toHaveLength(1);
  });

  it("Test 9 — a denied action traces the denial and no physical activity", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Done.")];

    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-deny",
      null,
      scripted(turns),
    );
    await resumeWarehouseAgent(paused.approval!.approvalId, "DENY", scripted(turns));

    const trace = await traceOf(paused.traceId);
    expect(trace.status).toBe("DENIED");
    expect(types(trace)).toContain("APPROVAL_DENIED");
    for (const forbidden of [
      "GRAPH_STARTED",
      "GANTRY_COMPLETED",
      "MOVEMENT_COMPLETED",
      "INVENTORY_UPDATED",
    ]) {
      expect(types(trace)).not.toContain(forbidden);
    }
    expect(await prisma.inventory.count()).toBe(0);
  });

  it("Test 10 — an expired approval ends the trace with no mutation events", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Done.")];
    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-expire",
      null,
      scripted(turns),
    );

    // Expire it exactly as the passage of time would.
    await prisma.actionApproval.update({
      where: { id: paused.approval!.approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const refused = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      scripted(turns),
    );
    expect(refused.ok).toBe(false);

    const trace = await traceOf(paused.traceId);
    expect(trace.status).toBe("EXPIRED");
    expect(types(trace)).toContain("APPROVAL_EXPIRED");
    expect(types(trace)).not.toContain("INVENTORY_UPDATED");
    expect(await prisma.inventory.count()).toBe(0);
  });

  it("Test 14 — approving twice never traces two gantry successes", async () => {
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Stored.")];
    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-double",
      null,
      scripted(turns),
    );
    await resumeWarehouseAgent(paused.approval!.approvalId, "APPROVE", scripted(turns));
    const second = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      scripted(turns),
    );

    expect(second.ok).toBe(false);
    const trace = await traceOf(paused.traceId);
    expect(named(trace, "GANTRY_COMPLETED")).toHaveLength(1);
    expect(named(trace, "INVENTORY_UPDATED")).toHaveLength(1);
    expect(await prisma.inventory.count()).toBe(1);
  });

  it("Test 12 — a gantry failure traces the failure and no inventory change", async () => {
    simulator().failNextOperation("pickup_failed");
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Failed.")];

    const paused = await invokeWarehouseAgent(
      "Store this part.",
      bearingScan(),
      "req-fail",
      null,
      scripted(turns),
    );
    const resumed = await resumeWarehouseAgent(
      paused.approval!.approvalId,
      "APPROVE",
      scripted([textTurn("The gantry could not complete it.")]),
    );
    expect(resumed.ok).toBe(true);

    const trace = await traceOf(paused.traceId);
    expect(trace.status).toBe("FAILED");
    expect(types(trace)).toContain("GRAPH_STEP_FAILED");
    expect(types(trace)).toContain("GANTRY_FAILED");
    expect(types(trace)).toContain("MOVEMENT_FAILED");
    // The assertion that matters: a failed move never reports stock.
    expect(types(trace)).not.toContain("INVENTORY_UPDATED");
    expect(types(trace)).not.toContain("GANTRY_COMPLETED");
    expect(await prisma.inventory.count()).toBe(0);

    const failedStep = named(trace, "GRAPH_STEP_FAILED")[0];
    expect(failedStep.name).toBe("putaway_execute");
    expect(failedStep.metadata?.reason).toBe("gantry_failed");
    expect(named(trace, "GANTRY_FAILED")[0].metadata?.error).toBe("pickup_failed");
  });

  it("Test 11 — an ambiguous match traces the human decision, not an execution", async () => {
    await createPart(BOLT);
    await createPart(BOLT_FLANGE);
    const scan = boltScan();

    const opened = await requestCatalogResolution(scan);
    expect(opened.status).toBe("HUMAN_DECISION_REQUIRED");
    if (opened.status !== "HUMAN_DECISION_REQUIRED") return;

    const resolutionTrace = await traceOf(catalogResolutionTraceId(opened.resolutionId));
    expect(types(resolutionTrace)).toEqual(["CATALOG_RESOLUTION_REQUIRED"]);
    expect(resolutionTrace.events[0].metadata).toMatchObject({
      resolutionId: opened.resolutionId,
      scanId: scan.scanId,
      originalMatchStatus: "AMBIGUOUS",
    });
    // A decision request is not an execution.
    expect(types(resolutionTrace)).not.toContain("GANTRY_COMPLETED");
    expect(types(resolutionTrace)).not.toContain("INVENTORY_UPDATED");

    const chosen = opened.candidates.find((candidate) => candidate.sku === "BOLT-M8-50")!;
    await confirmCatalogResolution(opened.resolutionId, chosen.partId);

    const confirmed = await traceOf(catalogResolutionTraceId(opened.resolutionId));
    expect(types(confirmed)).toEqual([
      "CATALOG_RESOLUTION_REQUIRED",
      "CATALOG_RESOLUTION_CONFIRMED",
    ]);
    expect(confirmed.status).toBe("COMPLETED");
    expect(confirmed.events[1].metadata).toMatchObject({ sku: "BOLT-M8-50" });
  });
});

/* --------------------------------------------------------- resilience */

describe("observability never breaks the warehouse", () => {
  it("Test 13 — a trace write failure changes nothing and retries nothing", async () => {
    const failure = new Error("trace store unavailable");
    const restore = breakPrismaMethod(prisma.traceEvent, "create", failure);
    const turns = [toolUseTurn("execute_putaway", "tool-1", "{}"), textTurn("Stored.")];

    try {
      const paused = await invokeWarehouseAgent(
        "Store this part.",
        bearingScan(),
        "req-tracefail",
        null,
        scripted(turns),
      );
      expect(paused.status).toBe("APPROVAL_REQUIRED");

      const resumed = await resumeWarehouseAgent(
        paused.approval!.approvalId,
        "APPROVE",
        scripted(turns),
      );

      // The warehouse operation is authoritative and unaffected.
      expect(resumed.ok).toBe(true);
      expect(await prisma.inventory.count()).toBe(1);
      const movements = await prisma.movement.findMany();
      expect(movements).toHaveLength(1);
      expect(movements[0].status).toBe("COMPLETED");
      // And exactly one physical operation — a dropped log line must never
      // cause a part to be moved again.
      expect((await simulator().getRecentOperations()).length).toBe(1);
      expect(restore.calls).toBeGreaterThan(0);
    } finally {
      restore.undo();
    }
  });

  it("a read-only request still answers when tracing is broken", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "B03", quantity: 2 });
    const restore = breakPrismaMethod(
      prisma.agentTrace,
      "create",
      new Error("trace store unavailable"),
    );
    try {
      const reply = await invokeWarehouseAgent(
        "Where is BRG-6204?",
        undefined,
        "req-readfail",
        null,
        scripted([
          toolUseTurn("search_inventory", "tool-1", JSON.stringify({ query: "BRG-6204" })),
          textTurn("BRG-6204 is in B03."),
        ]),
      );
      expect(reply.status).toBe("COMPLETED");
      expect(reply.toolCalls).toEqual(["search_inventory"]);
    } finally {
      restore.undo();
    }
  });
});

/* ------------------------------------------------------- API surface */

describe("observability API", () => {
  it("Test 18 — exposes reads only, and offers no way to replay an action", async () => {
    const list = await import("@/app/api/observability/traces/route");
    const detail = await import("@/app/api/observability/traces/[id]/route");

    const handlers = (module: Record<string, unknown>) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
        (method) => typeof module[method] === "function",
      );

    // A trace viewer that could POST would be a way to move a physical part
    // without an approval and without an idempotency key.
    expect(handlers(list as Record<string, unknown>)).toEqual(["GET"]);
    expect(handlers(detail as Record<string, unknown>)).toEqual(["GET"]);
  });

  it("returns a sanitized trace over the API, with no SDK objects in it", async () => {
    const { GET } = await import("@/app/api/observability/traces/[id]/route");
    const traceId = await startTrace({ requestSummary: "API check" });
    await recordEvent(traceId, {
      type: "TOOL_COMPLETED",
      status: "COMPLETED",
      name: "search_inventory",
      summary: "BRG-6204 — 2 in stock, B03 (2)",
      durationMs: 84,
      metadata: { toolUseId: "t1", sku: "BRG-6204" },
    });

    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: traceId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as TraceView;

    expect(body.traceId).toBe(traceId);
    expect(body.events[0]).toMatchObject({
      sequence: 1,
      type: "TOOL_COMPLETED",
      category: "TOOL",
      durationMs: 84,
    });
    // Nothing from the SDK, the prompt or the model's private state.
    const serialized = JSON.stringify(body);
    for (const forbidden of ["systemPrompt", "messages", "reasoning", "thinking", "modelId"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
