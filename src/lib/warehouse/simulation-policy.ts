/** Shared browser/server policy for the public simulation workspace. */
export const SIMULATION_ELIGIBLE_BINS: readonly string[] = ["B1-01", "B1-02"];
export const SIMULATION_LOCK_REASON =
  "Simulation is locked for this demo because Prod mode can trigger real hardware, including the Raspberry Pi camera. Only B1-01 and B1-02 can be moved.";

export function isSimulationEligibleBin(binCode: string): boolean {
  return SIMULATION_ELIGIBLE_BINS.includes(binCode.trim().toUpperCase());
}

export function simulationScopeMessage(binCode: string): string {
  return `Bin ${binCode} cannot be moved in this demo. Simulation is locked; only ${SIMULATION_ELIGIBLE_BINS.join(" and ")} can be moved. Try “RackHand, prep the self-tapping screws for the sensor enclosure.”.`;
}
