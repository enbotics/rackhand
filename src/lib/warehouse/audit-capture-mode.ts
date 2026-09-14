import { isSimulationEligibleBin, SIMULATION_LOCK_REASON, simulationScopeMessage } from "./simulation-policy";

export { isSimulationEligibleBin, SIMULATION_ELIGIBLE_BINS } from "./simulation-policy";
export type AuditCaptureMode = "PROD" | "SIMULATION";

/** The public demo cannot enable physical capture through env or stale runtime state. */
export function getAuditCaptureMode(): AuditCaptureMode {
  return "SIMULATION";
}

export function setAuditCaptureMode(mode: AuditCaptureMode): void {
  if (mode !== "SIMULATION") throw new Error(SIMULATION_LOCK_REASON);
}

export function isAuditCaptureMode(value: unknown): value is AuditCaptureMode {
  return value === "PROD" || value === "SIMULATION";
}

export function isOutOfSimulationScope(binCode: string): boolean {
  return !isSimulationEligibleBin(binCode);
}

export class SimulationScopeError extends Error {
  constructor(binCode: string) {
    super(simulationScopeMessage(binCode));
    this.name = "SimulationScopeError";
  }
}
