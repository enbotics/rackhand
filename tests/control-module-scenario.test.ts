import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ readBins: vi.fn(), mode: "SIMULATION" }));
vi.mock("@/lib/warehouse/db", () => ({ prisma: { bin: { findMany: fixture.readBins } } }));
vi.mock("@/lib/gantry/factory", () => ({ getGantryMode: () => fixture.mode }));

import { setAuditCaptureMode } from "@/lib/warehouse/audit-capture-mode";
import { beginControlModuleScenario, controlModuleFrame, controlModuleFinalReport,
  controlModuleScenarioPlan, controlModuleScenarioRunning, isControlModuleScenarioBin,
  recordControlModuleCheckout, recordControlModuleReturn } from "@/lib/warehouse/control-module-scenario";

const prompt = "RackHand, prep the parts for the control module.";
const rows = [
  { code: "B6-03", status: "OCCUPIED", inventory: [{ quantity: 30, part: { sku: "SPACERS", canonicalName: "Aluminum spacers" } }] },
  { code: "B4-01", status: "OCCUPIED", inventory: [{ quantity: 12, part: { sku: "HARDWARE", canonicalName: "Mounting hardware" } }] },
  { code: "B3-03", status: "OCCUPIED", inventory: [{ quantity: 20, part: { sku: "DRIVER", canonicalName: "Motor driver" } }] },
];
beforeEach(() => { vi.clearAllMocks(); setAuditCaptureMode("SIMULATION"); fixture.mode = "SIMULATION"; fixture.readBins.mockResolvedValue(rows); });
afterEach(() => setAuditCaptureMode("PROD"));

describe("explicit control module browser scenario", () => {
  it("runs all three outcomes in order and reports only after all bins return", async () => {
    const sessionId = "control-module-complete";
    expect(await beginControlModuleScenario(prompt, sessionId)).toBe(true);
    const plan = controlModuleScenarioPlan(sessionId);
    expect(plan?.selectedBins.map((bin) => bin.binCode)).toEqual(["B4-01", "B3-03", "B6-03"]);
    expect(controlModuleFinalReport(sessionId)).toBeNull();
    expect(controlModuleScenarioRunning(sessionId)).toBe(true);
    const frame = (binCode: string, operation: string, expectedQuantity: number, attempt = 0) =>
      controlModuleFrame({ sessionId, binCode, operation, expectedQuantity, attempt });

    // Bin 1 matches recorded quantity, then returns one item lighter.
    expect(frame("B4-01", "RETRIEVAL", 12)?.vision).toMatchObject({ observedCount: 12, foreignObjectSuspected: false });
    expect(frame("B3-03", "RETRIEVAL", 20)).toBeNull();
    recordControlModuleCheckout(sessionId, "B4-01", 12, 0);
    expect(frame("B4-01", "PUTAWAY", 12)?.vision.observedCount).toBe(11);
    expect(isControlModuleScenarioBin(sessionId, "B3-03")).toBe(false);
    recordControlModuleReturn(sessionId, "B4-01", 11);

    // Bin 2 has a trusted mismatch at checkout; return uses the new baseline.
    expect(frame("B3-03", "RETRIEVAL", 20)?.vision.observedCount).toBe(18);
    recordControlModuleCheckout(sessionId, "B3-03", 18, 0);
    expect(frame("B3-03", "PUTAWAY", 18)?.vision.observedCount).toBe(17);
    recordControlModuleReturn(sessionId, "B3-03", 17);

    // Bin 3 requires removal/retry, then goes back to B6-03, not B3-03.
    const contaminated = frame("B6-03", "RETRIEVAL", 30)!;
    expect(contaminated.vision.foreignObjects).toEqual(["unexpected object"]);
    expect(contaminated.svg).toContain("Other object");
    const cleared = frame("B6-03", "RETRIEVAL", 30, 1)!;
    expect(cleared.vision.foreignObjectSuspected).toBe(false);
    expect(cleared.svg).not.toContain("Other object");
    recordControlModuleCheckout(sessionId, "B6-03", 30, 1);
    expect(frame("B6-03", "PUTAWAY", 30)?.vision.observedCount).toBe(29);
    expect(controlModuleFinalReport(sessionId)).toBeNull();
    recordControlModuleReturn(sessionId, "B6-03", 29);
    const report = controlModuleFinalReport(sessionId)!;
    expect(report).toContain("All 3 bins checked and returned");
    expect(report).toContain("B4-01: recorded 12, verified 12, remaining 11");
    expect(report).toContain("B3-03: recorded 20, verified 18, remaining 17");
    expect(report).toContain("B6-03: recorded 30, verified 30, remaining 29");
    expect(report).toContain("Unexpected object removed; retry passed");
    expect(report).toContain("Browser simulation");
    expect(controlModuleScenarioRunning(sessionId)).toBe(false);
  });

  it("never scripts production evidence or a real gantry", async () => {
    setAuditCaptureMode("PROD");
    expect(await beginControlModuleScenario(prompt, "prod")).toBe(false);
    setAuditCaptureMode("SIMULATION"); fixture.mode = "HARDWARE";
    expect(await beginControlModuleScenario(prompt, "real-hardware")).toBe(false);
    expect(fixture.readBins).not.toHaveBeenCalled();
  });

  it("does not activate for planning, other prompts or another session", async () => {
    expect(await beginControlModuleScenario("Analyze tomorrow's plan", "planning")).toBe(false);
    expect(isControlModuleScenarioBin("unrelated", "B4-01")).toBe(false);
    expect(fixture.readBins).not.toHaveBeenCalled();
  });

  it("fails before movement if a required bin is unavailable", async () => {
    fixture.readBins.mockResolvedValueOnce(rows.slice(1));
    await expect(beginControlModuleScenario(prompt, "missing-bin")).rejects.toThrow("B6-03");
    expect(controlModuleScenarioPlan("missing-bin")).toBeNull();
  });
});
