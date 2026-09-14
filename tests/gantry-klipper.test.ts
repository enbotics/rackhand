import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lease = vi.hoisted(() => vi.fn());
vi.mock("@/lib/warehouse/hardware-lease", () => ({ withWarehouseHardwareLease: lease }));

import { KlipperGantryController } from "@/lib/gantry/klipper";
import { getGantryController, getGantryMode, resetGantryController } from "@/lib/gantry/factory";
import { assertGantryDevRoute } from "@/lib/gantry/http";
import { getAuditCaptureMode, isOutOfSimulationScope } from "@/lib/warehouse/audit-capture-mode";
import { GET, POST } from "@/app/api/warehouse/audit-capture-mode/route";

const printer = (axes = "xyz", state = "ready", activity = "Ready") => ({
  status: { webhooks: { state }, toolhead: { homed_axes: axes }, idle_timeout: { state: activity } },
});
const json = (result: unknown, status = 200) => new Response(JSON.stringify({ result }), { status });
function transport() {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => json(init?.method === "POST" ? "ok" : printer()));
}
function makeController(http = transport()) {
  return { http, controller: new KlipperGantryController({ baseUrl: "https://kli-prod.enbotics.tech", apiKey: "test-key", fetch: http }) };
}
function production() {
  vi.stubEnv("WAREHOUSE_SIMULATION_LOCKED", "false");
  vi.stubEnv("GANTRY_MODE", "production");
  vi.stubEnv("AUDIT_CAPTURE_MODE", "PROD");
  vi.stubEnv("KLIPPER_BASE_URL", "https://kli-prod.enbotics.tech");
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WAREHOUSE_SIMULATION_LOCKED", "true");
  resetGantryController();
  lease.mockImplementation((work: () => Promise<unknown>) => work());
});
afterEach(() => { resetGantryController(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Moonraker production controller", () => {
  it("runs every workflow macro with validated bin/station parameters and a completion barrier", async () => {
    const { http, controller } = makeController();
    const operations = [
      await controller.home(),
      await controller.putaway({ source: "INTAKE", destination: "B6-03" }),
      await controller.retrieve({ source: "B6-03", destination: "OUTPUT" }),
      await controller.presentBin({ source: "B6-03", destination: "INTAKE" }),
      await controller.returnBin({ source: "OUTPUT", destination: "B6-03" }),
      await controller.presentBinForAudit({ binCode: "B6-03" }),
      await controller.returnBinFromAudit({ binCode: "B6-03" }),
    ];
    expect(operations.every((operation) => operation.status === "COMPLETED")).toBe(true);
    const posts = http.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)).script)).toEqual([
      "RACKHAND_HOME\nM400",
      "RACKHAND_PUTAWAY BIN=B6-03 BED=6 SLOT=3 STATION=INTAKE\nM400",
      "RACKHAND_RETRIEVE BIN=B6-03 BED=6 SLOT=3 STATION=OUTPUT\nM400",
      "RACKHAND_RETRIEVE BIN=B6-03 BED=6 SLOT=3 STATION=INTAKE\nM400",
      "RACKHAND_RETURN BIN=B6-03 BED=6 SLOT=3 STATION=OUTPUT\nM400",
      "RACKHAND_RETRIEVE BIN=B6-03 BED=6 SLOT=3 STATION=SCAN_STATION\nM400",
      "RACKHAND_RETURN BIN=B6-03 BED=6 SLOT=3 STATION=SCAN_STATION\nM400",
    ]);
    expect(String(posts[0][0])).toBe("https://kli-prod.enbotics.tech/printer/gcode/script");
    expect(posts[0][1]).toMatchObject({ headers: { "X-Api-Key": "test-key" }, redirect: "error" });
    expect(await controller.getStatus()).toMatchObject({ mode: "PRODUCTION", state: "IDLE", homed: true, currentLocation: null });
    const history = await controller.getRecentOperations();
    history[0].status = "FAILED";
    expect((await controller.getRecentOperations())[0].status).toBe("COMPLETED");
  });

  it("supports explicit macro overrides and a reverse proxy API prefix", async () => {
    const http = transport();
    const controller = new KlipperGantryController({ baseUrl: "https://example.test/moonraker/", macros: { retrieve: "FETCH_BIN" }, fetch: http });
    await controller.retrieve({ source: "B1-01", destination: "OUTPUT" });
    const post = http.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe("https://example.test/moonraker/printer/gcode/script");
    expect(JSON.parse(String(post[1]?.body)).script).toBe("FETCH_BIN BIN=B1-01 BED=1 SLOT=1 STATION=OUTPUT\nM400");
  });

  it.each([
    ["", "ready", "Ready", "gantry_not_ready"],
    ["xy", "ready", "Ready", "gantry_not_ready"],
    ["xyz", "shutdown", "Ready", "gantry_not_ready"],
    ["xyz", "ready", "Printing", "gantry_busy"],
  ])("does not send a movement when axes=%s, state=%s, activity=%s", async (axes, state, activity, code) => {
    const http = transport().mockResolvedValue(json(printer(axes, state, activity)));
    const { controller } = makeController(http);
    await expect(controller.retrieve({ source: "B1-01", destination: "OUTPUT" })).rejects.toMatchObject({ code });
    expect(http.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("permits homing an unhomed machine and requires the resulting homed axes", async () => {
    const http = transport().mockResolvedValueOnce(json(printer("")));
    const { controller } = makeController(http);
    expect((await controller.home()).status).toBe("COMPLETED");
    const unhomed = makeController(transport().mockImplementation(async (_url, init) => json(init?.method === "POST" ? "ok" : printer(""))));
    expect(await unhomed.controller.home()).toMatchObject({ status: "FAILED", error: "controller_error" });
  });

  it("claims the operation before asynchronous preflight so two requests cannot overlap", async () => {
    let release!: (value: Response) => void;
    const http = transport().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { controller } = makeController(http);
    const first = controller.retrieve({ source: "B1-01", destination: "OUTPUT" });
    await expect(controller.retrieve({ source: "B1-02", destination: "OUTPUT" })).rejects.toMatchObject({ code: "gantry_busy" });
    release(json(printer()));
    expect((await first).status).toBe("COMPLETED");
    expect(http.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["http", "rpc", "timeout", "acknowledgement", "postflight"])("fails and prevents automatic retries after %s uncertainty", async (failure) => {
    const http = transport();
    if (failure === "postflight") {
      http.mockResolvedValueOnce(json(printer())).mockResolvedValueOnce(json("ok"))
        .mockResolvedValueOnce(json(printer("xyz", "shutdown")));
    } else {
      http.mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return json(printer());
        if (failure === "timeout") throw new DOMException("private endpoint details", "TimeoutError");
        if (failure === "http") return json("secret response", 500);
        if (failure === "rpc") return new Response(JSON.stringify({ error: { message: "private server details" } }));
        return json("unexpected");
      });
    }
    const { controller } = makeController(http);
    expect(await controller.retrieve({ source: "B1-01", destination: "OUTPUT" })).toMatchObject({
      status: "FAILED", reconciliationRequired: true, error: failure === "timeout" ? "movement_timeout" : "controller_error",
    });
    const status = await controller.getStatus();
    expect(status.state).toBe("ERROR");
    expect(status.lastError).not.toMatch(/private|secret/);
    await expect(controller.home()).rejects.toMatchObject({ code: "gantry_reconciliation_required" });
    expect(http.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reports offline status and sends no command when preflight cannot read the required objects", async () => {
    const http = transport().mockResolvedValue(json({ status: { toolhead: { homed_axes: "xyz" } } }));
    const { controller } = makeController(http);
    expect(await controller.getStatus()).toMatchObject({ state: "OFFLINE", homed: false });
    await expect(controller.home()).rejects.toMatchObject({ code: "gantry_offline" });
    expect(http.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("rejects unconfigured rack positions and injected commands before any HTTP request", async () => {
    const { http, controller } = makeController();
    for (const binCode of ["B9-99", "B1-06", "B1-01\nG28"]) {
      await expect(async () => controller.presentBinForAudit({ binCode })).rejects.toMatchObject({ code: "invalid_location" });
    }
    expect(http).not.toHaveBeenCalled();
    for (const macro of ["G28\nG1 X999", "FETCH BIN=B1-01", "", "MACRO1BAD"]) {
      expect(() => new KlipperGantryController({ baseUrl: "https://example.test", macros: { retrieve: macro } })).toThrow("one macro name");
    }
    for (const baseUrl of ["", "file:///tmp/klipper", "https://user:secret@example.test", "https://example.test?secret=value"]) {
      expect(() => new KlipperGantryController({ baseUrl })).toThrow("KLIPPER_BASE_URL");
    }
  });
});

describe("production deployment policy", () => {
  it("selects one shared production controller with the warehouse lease and physical capture scope", async () => {
    production();
    const http = transport();
    vi.stubGlobal("fetch", http);
    const controller = getGantryController();
    expect(controller).toBe(getGantryController());
    expect(getGantryMode()).toBe("PRODUCTION");
    expect(getAuditCaptureMode()).toBe("PROD");
    expect(isOutOfSimulationScope("B6-03")).toBe(false);
    expect((await controller.retrieve({ source: "B6-03", destination: "OUTPUT" })).status).toBe("COMPLETED");
    expect(lease).toHaveBeenCalledTimes(1);
    expect(await controller.getStatus()).toMatchObject({ mode: "PRODUCTION", simulationLocked: false });
  });

  it("requires an explicit server unlock, a valid mode, API URL, and physical evidence", () => {
    vi.stubEnv("GANTRY_MODE", "production");
    expect(getGantryMode()).toBe("SIMULATION");
    production();
    vi.stubEnv("AUDIT_CAPTURE_MODE", "SIMULATION");
    expect(() => getGantryController()).toThrow("AUDIT_CAPTURE_MODE=PROD");
    vi.stubEnv("AUDIT_CAPTURE_MODE", "PROD");
    vi.stubEnv("KLIPPER_BASE_URL", "");
    expect(() => getGantryController()).toThrow("KLIPPER_BASE_URL");
    vi.stubEnv("GANTRY_MODE", "invalid");
    expect(() => getGantryMode()).toThrow("GANTRY_MODE");
  });

  it("exposes the configured mode without allowing a browser mode switch", async () => {
    production();
    expect(await (await GET()).json()).toMatchObject({ mode: "PROD", locked: false });
    const request = (mode: string) => new Request("http://localhost", { method: "POST", body: JSON.stringify({ mode }) });
    expect((await POST(request("PROD"))).status).toBe(200);
    expect(await (await POST(request("SIMULATION"))).json()).toMatchObject({ error: { code: "capture_mode_env_only" } });
    expect(getAuditCaptureMode()).toBe("PROD");
  });

  it("blocks raw gantry routes even in next dev when real hardware is selected", () => {
    production();
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertGantryDevRoute()).toThrow("development-only");
  });
});
