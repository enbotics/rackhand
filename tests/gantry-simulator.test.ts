import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { GantryError } from "@/lib/gantry/errors";
import { getGantryController, getGantryMode, resetGantryController } from "@/lib/gantry/factory";
import { SimulatedGantryController } from "@/lib/gantry/simulator";
import type { PutawayRequest, RetrievalRequest } from "@/lib/gantry/types";
import { resetWarehouse } from "./helpers";

/** Fast delays so the suite stays quick; the state machine is identical. */
function makeSimulator() {
  return new SimulatedGantryController({
    moveDelayMs: 4,
    pickDelayMs: 3,
    dropDelayMs: 3,
    homeDelayMs: 4,
    binTransferDelayMs: 12,
    historyLimit: 5,
  });
}

async function expectGantryError(promise: Promise<unknown>, code: string): Promise<GantryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GantryError);
    const error = err as GantryError;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected a GantryError with code "${code}", but the call succeeded.`);
}

let gantry: SimulatedGantryController;

beforeEach(() => {
  gantry = makeSimulator();
});

describe("initial status", () => {
  it("starts IDLE with nothing running", async () => {
    const status = await gantry.getStatus();
    expect(status).toEqual({
      mode: "SIMULATION",
      state: "IDLE",
      currentLocation: null,
      homed: false,
      activeOperationId: null,
      lastError: null,
    });
    expect(await gantry.getRecentOperations()).toEqual([]);
  });
});

describe("home", () => {
  it("completes and marks the machine homed", async () => {
    const operation = await gantry.home();

    expect(operation.type).toBe("HOME");
    expect(operation.status).toBe("COMPLETED");
    expect(operation.error).toBeNull();
    expect(operation.source).toBeNull();
    expect(operation.destination).toBeNull();
    expect(operation.operationId).toMatch(/^gantry_\d+_[a-z0-9]{6}$/);
    expect(operation.startedAt).toBeTypeOf("number");
    expect(operation.completedAt).toBeGreaterThanOrEqual(operation.startedAt!);

    const status = await gantry.getStatus();
    expect(status.state).toBe("IDLE");
    expect(status.homed).toBe(true);
    expect(status.currentLocation).toBeNull();
    expect(status.activeOperationId).toBeNull();
  });
});

describe("putaway", () => {
  it("completes INTAKE -> B2-01 and leaves the head at the bin", async () => {
    const operation = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });

    expect(operation.type).toBe("PUTAWAY");
    expect(operation.status).toBe("COMPLETED");
    expect(operation.source).toBe("INTAKE");
    expect(operation.destination).toBe("B2-01");
    expect(operation.error).toBeNull();

    const status = await gantry.getStatus();
    expect(status.state).toBe("IDLE");
    expect(status.currentLocation).toBe("B2-01");
  });

  it("passes through MOVING, PICKING and DROPPING in order", async () => {
    const seen: string[] = [];
    const pending = gantry.putaway({ source: "INTAKE", destination: "B1-02" });
    for (let i = 0; i < 40; i++) {
      const { state } = await gantry.getStatus();
      if (seen[seen.length - 1] !== state) seen.push(state);
      if (state === "IDLE" && seen.length > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await pending;

    expect(seen).toEqual(["MOVING", "PICKING", "MOVING", "DROPPING", "IDLE"]);
  });

  it("rejects a source that is not INTAKE", async () => {
    const error = await expectGantryError(
      gantry.putaway({ source: "B1-01", destination: "B2-01" } as unknown as PutawayRequest),
      "invalid_location",
    );
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/must start at INTAKE/);
  });

  it("rejects an unknown bin as destination", async () => {
    await expectGantryError(
      gantry.putaway({ source: "INTAKE", destination: "Z99" } as unknown as PutawayRequest),
      "invalid_location",
    );
  });

  it("rejects a destination equal to the source", async () => {
    const error = await expectGantryError(
      gantry.putaway({ source: "INTAKE", destination: "INTAKE" } as unknown as PutawayRequest),
      "invalid_location",
    );
    expect(error.message).toMatch(/must differ/);
  });

  it("rejects a missing or malformed body", async () => {
    for (const bad of [undefined, null, {}, { source: "INTAKE" }]) {
      await expectGantryError(gantry.putaway(bad as unknown as PutawayRequest), "invalid_location");
    }
  });

  it("records nothing when the request is rejected", async () => {
    await expectGantryError(
      gantry.putaway({ source: "OUTPUT", destination: "B2-01" } as unknown as PutawayRequest),
      "invalid_location",
    );
    expect(await gantry.getRecentOperations()).toEqual([]);
    expect((await gantry.getStatus()).state).toBe("IDLE");
  });
});

describe("retrieval", () => {
  it("completes B2-01 -> OUTPUT and leaves the head at the station", async () => {
    const operation = await gantry.retrieve({ source: "B2-01", destination: "OUTPUT" });

    expect(operation.type).toBe("RETRIEVAL");
    expect(operation.status).toBe("COMPLETED");
    expect(operation.source).toBe("B2-01");
    expect(operation.destination).toBe("OUTPUT");
    expect((await gantry.getStatus()).currentLocation).toBe("OUTPUT");
  });

  it("rejects a destination that is not OUTPUT", async () => {
    const error = await expectGantryError(
      gantry.retrieve({ source: "B2-01", destination: "B1-01" } as unknown as RetrievalRequest),
      "invalid_location",
    );
    expect(error.message).toMatch(/must end at OUTPUT/);
  });

  it("rejects an unknown bin as source", async () => {
    await expectGantryError(
      gantry.retrieve({ source: "Z99", destination: "OUTPUT" } as unknown as RetrievalRequest),
      "invalid_location",
    );
  });

  it("rejects a source equal to the destination", async () => {
    await expectGantryError(
      gantry.retrieve({ source: "OUTPUT", destination: "OUTPUT" } as unknown as RetrievalRequest),
      "invalid_location",
    );
  });
});

describe("guided bin transfer", () => {
  it("presents a selected bin at INTAKE and returns it to the same slot", async () => {
    const presented = await gantry.presentBin({ source: "B2-01", destination: "INTAKE" });

    expect(presented).toMatchObject({
      type: "BIN_PRESENTATION",
      source: "B2-01",
      destination: "INTAKE",
      status: "COMPLETED",
    });
    expect((await gantry.getStatus()).currentLocation).toBe("INTAKE");

    const returned = await gantry.returnBin({ source: "INTAKE", destination: "B2-01" });
    expect(returned).toMatchObject({
      type: "BIN_RETURN",
      source: "INTAKE",
      destination: "B2-01",
      status: "COMPLETED",
    });
    expect((await gantry.getStatus()).currentLocation).toBe("B2-01");
  });

  it("rejects malformed presentation and return routes", async () => {
    await expectGantryError(
      gantry.presentBin({ source: "not-a-bin", destination: "INTAKE" }),
      "invalid_location",
    );
    await expectGantryError(
      gantry.returnBin({ source: "INTAKE", destination: "not-a-bin" }),
      "invalid_location",
    );
  });

  it("retrieves an audited bin to SCAN_STATION and puts it back in the same shelf slot", async () => {
    const presented = await gantry.presentBinForAudit({ binCode: "B4-01" });
    expect(presented).toMatchObject({
      type: "AUDIT_PRESENTATION",
      source: "B4-01",
      destination: "SCAN_STATION",
      status: "COMPLETED",
    });
    expect((await gantry.getStatus()).currentLocation).toBe("SCAN_STATION");

    const returned = await gantry.returnBinFromAudit({ binCode: "B4-01" });
    expect(returned).toMatchObject({
      type: "AUDIT_RETURN",
      source: "SCAN_STATION",
      destination: "B4-01",
      status: "COMPLETED",
    });
    expect((await gantry.getStatus()).currentLocation).toBe("B4-01");
  });
});

describe("concurrency", () => {
  it("rejects a second operation while one is running", async () => {
    const running = gantry.putaway({ source: "INTAKE", destination: "B2-01" });

    const error = await expectGantryError(
      gantry.retrieve({ source: "B1-01", destination: "OUTPUT" }),
      "gantry_busy",
    );
    expect(error.status).toBe(409);
    await expectGantryError(gantry.home(), "gantry_busy");

    const first = await running;
    expect(first.status).toBe("COMPLETED");
  });

  it("exposes the active operation id while busy", async () => {
    const running = gantry.putaway({ source: "INTAKE", destination: "B1-04" });
    const status = await gantry.getStatus();

    expect(status.activeOperationId).toBeTruthy();
    expect(status.state).not.toBe("IDLE");

    const operation = await running;
    expect(status.activeOperationId).toBe(operation.operationId);
    expect((await gantry.getStatus()).activeOperationId).toBeNull();
  });

  it("accepts the next operation once the first finishes", async () => {
    await gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    const second = await gantry.retrieve({ source: "B2-01", destination: "OUTPUT" });
    expect(second.status).toBe("COMPLETED");
  });

  it("only records one operation for a rejected concurrent request", async () => {
    const running = gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    await expectGantryError(gantry.home(), "gantry_busy");
    await running;

    expect(await gantry.getRecentOperations()).toHaveLength(1);
  });
});

describe("deterministic failure injection", () => {
  it("fails the pick, keeping the head at the source", async () => {
    gantry.failNextOperation("pickup_failed");
    const operation = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });

    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("pickup_failed");
    expect(operation.completedAt).toBeTypeOf("number");

    const status = await gantry.getStatus();
    expect(status.state).toBe("IDLE");
    expect(status.lastError).toBe("pickup_failed");
    // Picked up nothing, but it did arrive at INTAKE before the failure.
    expect(status.currentLocation).toBe("INTAKE");
  });

  it("fails the drop after reaching the destination", async () => {
    gantry.failNextOperation("drop_failed");
    const operation = await gantry.retrieve({ source: "B2-01", destination: "OUTPUT" });

    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("drop_failed");
    expect((await gantry.getStatus()).currentLocation).toBe("OUTPUT");
  });

  it("fails a movement without arriving", async () => {
    gantry.failNextOperation("movement_timeout");
    const operation = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });

    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("movement_timeout");
    expect((await gantry.getStatus()).currentLocation).toBeNull();
  });

  it("fails at the start for an error with no matching phase", async () => {
    gantry.failNextOperation("controller_error");
    const operation = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });

    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("controller_error");
    expect((await gantry.getStatus()).currentLocation).toBeNull();
  });

  it("fails home() too", async () => {
    gantry.failNextOperation("movement_timeout");
    const operation = await gantry.home();

    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("movement_timeout");
    expect((await gantry.getStatus()).homed).toBe(false);
  });

  it("applies a pick failure at the start of home(), which has no PICKING phase", async () => {
    gantry.failNextOperation("pickup_failed");
    const operation = await gantry.home();
    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("pickup_failed");
  });

  it("fires exactly once, then normal behaviour resumes", async () => {
    gantry.failNextOperation("pickup_failed");

    const failed = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    expect(failed.status).toBe("FAILED");

    const recovered = await gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    expect(recovered.status).toBe("COMPLETED");
    expect(recovered.error).toBeNull();

    const status = await gantry.getStatus();
    expect(status.state).toBe("IDLE");
    expect(status.currentLocation).toBe("B2-01");
    // A later success clears the stale failure.
    expect(status.lastError).toBeNull();
  });

  it("recovers well enough to run a different operation type next", async () => {
    gantry.failNextOperation("controller_error");
    expect((await gantry.retrieve({ source: "B1-01", destination: "OUTPUT" })).status).toBe("FAILED");

    const homed = await gantry.home();
    expect(homed.status).toBe("COMPLETED");
    expect((await gantry.getStatus()).homed).toBe(true);
  });

  it("can be disarmed before it fires", async () => {
    gantry.failNextOperation("pickup_failed");
    gantry.clearFailureInjection();
    expect((await gantry.putaway({ source: "INTAKE", destination: "B2-01" })).status).toBe("COMPLETED");
  });

  it("is never triggered without injection", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await gantry.putaway({ source: "INTAKE", destination: "B1-01" })).status).toBe("COMPLETED");
    }
  });
});

describe("operation history", () => {
  it("lists completed and failed operations, newest first", async () => {
    await gantry.home();
    await gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    gantry.failNextOperation("pickup_failed");
    await gantry.retrieve({ source: "B2-01", destination: "OUTPUT" });

    const history = await gantry.getRecentOperations();
    expect(history.map((o) => `${o.type}:${o.status}`)).toEqual([
      "RETRIEVAL:FAILED",
      "PUTAWAY:COMPLETED",
      "HOME:COMPLETED",
    ]);
    expect(history[0].error).toBe("pickup_failed");
  });

  it("honours the limit and caps total retained history", async () => {
    for (let i = 0; i < 7; i++) {
      await gantry.putaway({ source: "INTAKE", destination: "B1-01" });
    }
    expect(await gantry.getRecentOperations(2)).toHaveLength(2);
    // historyLimit is 5 for this simulator.
    expect(await gantry.getRecentOperations(100)).toHaveLength(5);
  });
});

describe("controller factory", () => {
  afterEach(() => {
    resetGantryController();
    delete process.env.GANTRY_MODE;
  });

  it("defaults to the leased simulator and returns one process-local controller", async () => {
    resetGantryController();
    const first = getGantryController();
    expect((await first.getStatus()).mode).toBe("SIMULATION");
    expect(getGantryController()).toBe(first);
  });

  it("keeps the active controller when the factory module is loaded again", async () => {
    resetGantryController();
    const first = getGantryController();

    vi.resetModules();
    const reloadedFactory = await import("@/lib/gantry/factory");

    expect(reloadedFactory.getGantryController()).toBe(first);
  });

  it("reads GANTRY_MODE case-insensitively and falls back to SIMULATION", () => {
    process.env.GANTRY_MODE = "simulation";
    expect(getGantryMode()).toBe("SIMULATION");
    process.env.GANTRY_MODE = "nonsense";
    expect(getGantryMode()).toBe("SIMULATION");
  });

  it("refuses hardware mode — no hardware controller exists yet", () => {
    resetGantryController();
    process.env.GANTRY_MODE = "hardware";
    expect(() => getGantryController()).toThrow(GantryError);
    try {
      getGantryController();
    } catch (err) {
      expect((err as GantryError).code).toBe("gantry_mode_unsupported");
      expect((err as GantryError).status).toBe(501);
    }
  });
});

describe("warehouse independence", () => {
  beforeEach(async () => {
    await resetWarehouse();
  });

  it("changes no inventory and creates no Movement record", async () => {
    const before = {
      parts: await prisma.part.count(),
      inventory: await prisma.inventory.findMany(),
      movements: await prisma.movement.count(),
      bins: await prisma.bin.findMany({ orderBy: { code: "asc" } }),
    };

    await gantry.home();
    await gantry.putaway({ source: "INTAKE", destination: "B2-01" });
    await gantry.retrieve({ source: "B2-01", destination: "OUTPUT" });
    gantry.failNextOperation("drop_failed");
    await gantry.putaway({ source: "INTAKE", destination: "B1-01" });

    expect(await prisma.part.count()).toBe(before.parts);
    expect(await prisma.inventory.findMany()).toEqual(before.inventory);
    expect(await prisma.movement.count()).toBe(before.movements);
    // Bin statuses are warehouse truth — the gantry must not touch them.
    expect(await prisma.bin.findMany({ orderBy: { code: "asc" } })).toEqual(before.bins);
  });
});
