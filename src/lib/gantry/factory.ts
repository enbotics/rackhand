/**
 * Chooses which gantry implementation the application talks to.
 *
 * This is the only place that knows a simulator exists. Swapping in real
 * hardware later is a change here and nowhere else — routes, services and the
 * future Strands tool all depend on the GantryController interface.
 *
 * SIMULATION STATE IS PROCESS-LOCAL and intended for the local hackathon MVP.
 * The instance is cached on globalThis so Next.js hot reloads (and separate
 * route modules within one server process) share one machine instead of each
 * getting a fresh, unrelated one. It is not shared across processes, does not
 * survive a restart, and assumes no serverless persistence — deliberately no
 * Redis or external state.
 */
import type { GantryController } from "./controller";
import { GantryError } from "./errors";
import {
  DEFAULT_SIM_HOME_DELAY_MS,
  DEFAULT_SIM_BIN_TRANSFER_DELAY_MS,
  DEFAULT_SIM_MOVE_DELAY_MS,
  DEFAULT_SIM_PICK_DELAY_MS,
  DEFAULT_SIM_DROP_DELAY_MS,
  SimulatedGantryController,
  type SimulatorOptions,
} from "./simulator";
import type { GantryMode } from "./types";
import { withWarehouseHardwareLease } from "@/lib/warehouse/hardware-lease";
import { isSimulationEligibleBin, simulationScopeMessage } from "@/lib/warehouse/simulation-policy";

/** The public workspace is locked to the simulated controller. */
export function getGantryMode(): GantryMode {
  return "SIMULATION";
}

async function moveSimulationBin<T>(binCode: string, work: () => Promise<T>): Promise<T> {
  if (!isSimulationEligibleBin(binCode)) {
    throw new GantryError("simulation_scope_violation", simulationScopeMessage(binCode));
  }
  return withWarehouseHardwareLease(work);
}

function readDelay(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readSimulatorOptions(): SimulatorOptions {
  return {
    moveDelayMs: readDelay("GANTRY_SIM_MOVE_DELAY_MS", DEFAULT_SIM_MOVE_DELAY_MS),
    pickDelayMs: readDelay("GANTRY_SIM_PICK_DELAY_MS", DEFAULT_SIM_PICK_DELAY_MS),
    dropDelayMs: readDelay("GANTRY_SIM_DROP_DELAY_MS", DEFAULT_SIM_DROP_DELAY_MS),
    homeDelayMs: readDelay("GANTRY_SIM_HOME_DELAY_MS", DEFAULT_SIM_HOME_DELAY_MS),
    binTransferDelayMs: readDelay(
      "GANTRY_SIM_BIN_TRANSFER_DELAY_MS",
      DEFAULT_SIM_BIN_TRANSFER_DELAY_MS,
    ),
  };
}

/**
 * Route handlers may bundle this module independently. `instanceof` is not a
 * safe cache check in that situation: two copies of SimulatedGantryController
 * have different constructor identities even though they implement the same
 * controller. The status route could therefore replace the exact instance an
 * audit was moving, making the rack observe a fresh IDLE simulator forever.
 *
 * A small explicit version preserves one controller across route bundles and
 * still gives implementation changes a deliberate cache-busting mechanism.
 */
const GANTRY_CONTROLLER_CACHE_VERSION = 3;
const globalForGantry = globalThis as unknown as {
  gantryController?: GantryController;
  gantryControllerVersion?: number;
  leasedGantryController?: GantryController;
  leasedGantrySource?: GantryController;
};

export function getGantryController(): GantryController {
  if (
    !globalForGantry.gantryController ||
    globalForGantry.gantryControllerVersion !== GANTRY_CONTROLLER_CACHE_VERSION
  ) {
    globalForGantry.gantryController = new SimulatedGantryController(readSimulatorOptions());
    globalForGantry.gantryControllerVersion = GANTRY_CONTROLLER_CACHE_VERSION;
  }
  const controller = globalForGantry.gantryController;
  if (globalForGantry.leasedGantrySource !== controller) {
    globalForGantry.leasedGantrySource = controller;
    globalForGantry.leasedGantryController = {
      getStatus: () => controller.getStatus(),
      getRecentOperations: (limit) => controller.getRecentOperations(limit),
      home: () => withWarehouseHardwareLease(() => controller.home()),
      putaway: (input) => moveSimulationBin(input.destination, () => controller.putaway(input)),
      retrieve: (input) => moveSimulationBin(input.source, () => controller.retrieve(input)),
      presentBin: (input) => moveSimulationBin(input.source, () => controller.presentBin(input)),
      returnBin: (input) => moveSimulationBin(input.destination, () => controller.returnBin(input)),
      presentBinForAudit: (input) => moveSimulationBin(input.binCode, () => controller.presentBinForAudit(input)),
      returnBinFromAudit: (input) => moveSimulationBin(input.binCode, () => controller.returnBinFromAudit(input)),
    };
  }
  return globalForGantry.leasedGantryController!;
}

/** Test/dev helper: drop the cached instance so the next call builds a fresh machine. */
export function resetGantryController(): void {
  globalForGantry.gantryController = undefined;
  globalForGantry.gantryControllerVersion = undefined;
}
