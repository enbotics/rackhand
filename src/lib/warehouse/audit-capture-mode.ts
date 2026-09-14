import { isSimulationEligibleBin, SIMULATION_LOCK_REASON, simulationScopeMessage } from "./simulation-policy";
import { isWarehouseSimulationLocked } from "./deployment-mode";

export { isSimulationEligibleBin, SIMULATION_ELIGIBLE_BINS } from "./simulation-policy";
export type AuditCaptureMode = "PROD" | "SIMULATION";

/** The public demo stays locked; a private deployment chooses capture mode through env. */
export function getAuditCaptureMode(): AuditCaptureMode {
  if (isWarehouseSimulationLocked()) return "SIMULATION";
  const mode = process.env.AUDIT_CAPTURE_MODE?.trim().toUpperCase() ?? "PROD";
  if (mode === "PROD" || mode === "PRODUCTION") return "PROD";
  if (mode === "SIMULATION") return "SIMULATION";
  throw new Error("AUDIT_CAPTURE_MODE must be PROD or SIMULATION.");
}

export function setAuditCaptureMode(mode: AuditCaptureMode): void {
  if (isWarehouseSimulationLocked() && mode !== "SIMULATION") throw new Error(SIMULATION_LOCK_REASON);
  if (mode !== getAuditCaptureMode()) throw new Error("Configure AUDIT_CAPTURE_MODE in .env.local and restart the server.");
}

export function isAuditCaptureMode(value: unknown): value is AuditCaptureMode {
  return value === "PROD" || value === "SIMULATION";
}

export function isOutOfSimulationScope(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && !isSimulationEligibleBin(binCode);
}

export class SimulationScopeError extends Error {
  constructor(binCode: string) {
    super(simulationScopeMessage(binCode));
    this.name = "SimulationScopeError";
  }
}
