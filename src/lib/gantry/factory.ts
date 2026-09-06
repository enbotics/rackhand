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
  DEFAULT_SIM_MOVE_DELAY_MS,
  DEFAULT_SIM_PICK_DELAY_MS,
  DEFAULT_SIM_DROP_DELAY_MS,
  SimulatedGantryController,
  type SimulatorOptions,
} from "./simulator";
import { GANTRY_MODES, type GantryMode } from "./types";

/** GANTRY_MODE, case-insensitive; anything unrecognized falls back to SIMULATION. */
export function getGantryMode(): GantryMode {
  const raw = process.env.GANTRY_MODE?.trim().toUpperCase();
  return (GANTRY_MODES as readonly string[]).includes(raw ?? "") ? (raw as GantryMode) : "SIMULATION";
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
  };
}

const globalForGantry = globalThis as unknown as { gantryController?: GantryController };

export function getGantryController(): GantryController {
  const mode = getGantryMode();

  if (mode === "HARDWARE") {
    throw new GantryError(
      "gantry_mode_unsupported",
      "GANTRY_MODE=HARDWARE is reserved for a later milestone — no hardware controller is implemented. Use GANTRY_MODE=simulation.",
    );
  }

  globalForGantry.gantryController ??= new SimulatedGantryController(readSimulatorOptions());
  return globalForGantry.gantryController;
}

/** Test/dev helper: drop the cached instance so the next call builds a fresh machine. */
export function resetGantryController(): void {
  globalForGantry.gantryController = undefined;
}
