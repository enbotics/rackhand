import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ lease: vi.fn(), readBins: vi.fn(), readMovement: vi.fn(), updateMovement: vi.fn(), readCapture: vi.fn(), createJob: vi.fn() }));
vi.mock("@/lib/warehouse/hardware-lease", () => ({ withWarehouseHardwareLease: fixture.lease }));
vi.mock("@/lib/camera/storage", () => ({ readCameraCapture: vi.fn() }));
vi.mock("@/lib/warehouse/storage", () => ({ uploadPutawayPhoto: vi.fn() }));
vi.mock("@/lib/warehouse/db", () => ({ prisma: {
  bin: { findMany: fixture.readBins },
  movement: { findUnique: fixture.readMovement, updateMany: fixture.updateMovement },
  putawayCaptureRequest: { findUnique: fixture.readCapture },
  cameraCaptureJob: { create: fixture.createJob },
} }));

import { GET, POST } from "@/app/api/warehouse/audit-capture-mode/route";
import { getAuditCaptureMode, isOutOfSimulationScope, setAuditCaptureMode } from "@/lib/warehouse/audit-capture-mode";
import { getGantryController, getGantryMode, resetGantryController } from "@/lib/gantry/factory";
import { hasSimulationEvidence, isSimulationEvidenceUrl, nextSimulationEvidence, simulationBaselineUrl } from "@/lib/warehouse/simulation-evidence";
import { executePutaway, returnCheckedOutBin } from "@/lib/warehouse/putaway-service";
import { prepareGuidedPutaway, presentGuidedPutawayBin, returnGuidedPutawayBin } from "@/lib/warehouse/guided-putaway-service";
import { requestPutawayCameraCapture } from "@/lib/warehouse/putaway-verification";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WAREHOUSE_SIMULATION_LOCKED", "true");
  resetGantryController();
  fixture.lease.mockImplementation((work: () => Promise<unknown>) => work());
  for (const name of ["MOVE", "PICK", "DROP", "HOME", "BIN_TRANSFER"]) vi.stubEnv(`GANTRY_SIM_${name}_DELAY_MS`, "0");
});
afterEach(() => { resetGantryController(); vi.unstubAllEnvs(); });

const request = (body: unknown) => new Request("http://localhost/api/warehouse/audit-capture-mode", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

describe("locked public simulation", () => {
  it("ignores physical mode configuration and rejects Prod through the API and setter", async () => {
    vi.stubEnv("AUDIT_CAPTURE_MODE", "PROD");
    vi.stubEnv("GANTRY_MODE", "HARDWARE");
    expect(getAuditCaptureMode()).toBe("SIMULATION");
    expect(getGantryMode()).toBe("SIMULATION");
    expect((await getGantryController().getStatus()).mode).toBe("SIMULATION");
    expect(() => setAuditCaptureMode("PROD")).toThrow("real hardware");
    const rejected = await POST(request({ mode: "PROD" }));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ mode: "SIMULATION", locked: true, error: { code: "simulation_mode_locked" } });
    expect(await (await GET()).json()).toMatchObject({ mode: "SIMULATION", locked: true, eligibleBins: ["B1-01", "B1-02"] });
  });

  it("accepts Simulation and handles invalid JSON shapes without changing mode", async () => {
    expect((await POST(request({ mode: "SIMULATION" }))).status).toBe(200);
    for (const body of [null, [], {}, { mode: "HARDWARE" }]) expect((await POST(request(body))).status).toBe(422);
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
    expect(getAuditCaptureMode()).toBe("SIMULATION");
  });

  it("blocks every bin movement before acquiring a lease or recording motion", async () => {
    const controller = getGantryController();
    const blocked = [
      () => controller.putaway({ source: "INTAKE", destination: "B3-03" }),
      () => controller.retrieve({ source: "B3-03", destination: "OUTPUT" }),
      () => controller.presentBin({ source: "B3-03", destination: "INTAKE" }),
      () => controller.returnBin({ source: "OUTPUT", destination: "B3-03" }),
      () => controller.presentBinForAudit({ binCode: "B3-03" }),
      () => controller.returnBinFromAudit({ binCode: "B3-03" }),
    ];
    for (const move of blocked) await expect(move()).rejects.toMatchObject({ code: "simulation_scope_violation", status: 403 });
    expect(fixture.lease).not.toHaveBeenCalled();
    expect(await controller.getRecentOperations()).toEqual([]);
    expect((await controller.getStatus()).state).toBe("IDLE");
    expect(isOutOfSimulationScope("B1-01")).toBe(false);
    expect(isOutOfSimulationScope("B1-02")).toBe(false);
    expect(isOutOfSimulationScope("B1-03")).toBe(true);
  });

  it.each(["B1-01", "B1-02"])("allows simulated retrieval, return, presentation and auditing of %s", async (binCode) => {
    const controller = getGantryController();
    const operations = [
      await controller.retrieve({ source: binCode, destination: "OUTPUT" }),
      await controller.returnBin({ source: "OUTPUT", destination: binCode }),
      await controller.presentBin({ source: binCode, destination: "INTAKE" }),
      await controller.returnBin({ source: "INTAKE", destination: binCode }),
      await controller.presentBinForAudit({ binCode }),
      await controller.returnBinFromAudit({ binCode }),
      await controller.putaway({ source: "INTAKE", destination: binCode }),
    ];
    expect(operations.every((operation) => operation.status === "COMPLETED")).toBe(true);
    expect((await controller.getStatus()).mode).toBe("SIMULATION");
  });

  it("rejects explicit putaway and return destinations before any reservation", async () => {
    expect(await executePutaway({ destinationBinCode: "B3-03" } as Parameters<typeof executePutaway>[0])).toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    expect(await prepareGuidedPutaway({ destinationBinCode: "B3-03" } as Parameters<typeof prepareGuidedPutaway>[0])).toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    expect(await returnCheckedOutBin({ binCode: "B3-03" })).toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    expect(fixture.readBins).not.toHaveBeenCalled();
    expect(fixture.updateMovement).not.toHaveBeenCalled();
    expect(fixture.lease).not.toHaveBeenCalled();
  });

  it("rejects pending workflows for other bins before camera jobs or stage changes", async () => {
    fixture.readMovement.mockResolvedValue({ type: "PUTAWAY", destinationBin: { code: "B3-03" }, part: {} });
    expect(await presentGuidedPutawayBin("pending")).toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    expect(await returnGuidedPutawayBin("pending", { placed: false })).toMatchObject({ ok: false, reason: "simulation_scope_violation" });
    fixture.readCapture.mockResolvedValue({ status: "WAITING_FOR_CAMERA", movement: { status: "AWAITING_VERIFICATION", type: "RETRIEVAL", sourceBin: { code: "B3-03" } } });
    await expect(requestPutawayCameraCapture("pending")).rejects.toThrow("only B1-01 and B1-02");
    expect(fixture.updateMovement).not.toHaveBeenCalled();
    expect(fixture.createJob).not.toHaveBeenCalled();
    expect(fixture.lease).not.toHaveBeenCalled();
  });

  it("provides B1-02 simulation evidence from recorded quantity without scale readings", async () => {
    expect(await hasSimulationEvidence("B1-02")).toBe(true);
    const baseline = await simulationBaselineUrl("B1-02", 40);
    expect(isSimulationEvidenceUrl(baseline)).toBe(true);
    for (const quantity of [0, 40]) {
      const sample = await nextSimulationEvidence("B1-02", quantity);
      expect(sample.bytes.subarray(1, 4).toString()).toBe("PNG");
      expect(sample.simulatedInspection).toMatchObject({ observedCount: quantity, notes: expect.stringContaining("no physical camera or scale reading") });
      expect(isSimulationEvidenceUrl(sample.url)).toBe(true);
    }
    await expect(nextSimulationEvidence("B3-03", 20)).rejects.toThrow("not configured");
    expect(fixture.createJob).not.toHaveBeenCalled();
  });
});
