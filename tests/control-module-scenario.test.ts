import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ readBins: vi.fn(), mode: "SIMULATION" }));
vi.mock("@/lib/warehouse/db", () => ({ prisma: { bin: { findMany: fixture.readBins } } }));
vi.mock("@/lib/gantry/factory", () => ({ getGantryMode: () => fixture.mode }));

import { beginControlModuleScenario, controlModuleFrame, controlModuleScenarioPlan,
  controlModuleScenarioRunning, isControlModuleScenarioBin } from "@/lib/warehouse/control-module-scenario";

beforeEach(() => { vi.clearAllMocks(); fixture.mode = "SIMULATION"; });

describe("control module scenario under the public simulation lock", () => {
  it("cannot activate its three out-of-scope bins or override the movement allowlist", async () => {
    const sessionId = "blocked-control-module";
    expect(await beginControlModuleScenario("RackHand, prep the parts for the control module.", sessionId)).toBe(false);
    expect(controlModuleScenarioPlan(sessionId)).toBeNull();
    expect(controlModuleScenarioRunning(sessionId)).toBe(false);
    for (const binCode of ["B4-01", "B3-03", "B6-03"]) {
      expect(isControlModuleScenarioBin(sessionId, binCode)).toBe(false);
      expect(controlModuleFrame({ sessionId, binCode, operation: "RETRIEVAL", expectedQuantity: 20, attempt: 0 })).toBeNull();
    }
    expect(fixture.readBins).not.toHaveBeenCalled();
  });

  it("does not activate for unrelated prompts or a real gantry", async () => {
    expect(await beginControlModuleScenario("Bring me bin B1-02", "public")).toBe(false);
    fixture.mode = "HARDWARE";
    expect(await beginControlModuleScenario("RackHand, prep the parts for the control module.", "hardware")).toBe(false);
    expect(fixture.readBins).not.toHaveBeenCalled();
  });
});
