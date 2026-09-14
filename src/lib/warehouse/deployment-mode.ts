/** Only a server environment setting can unlock the public simulation workspace. */
export function isWarehouseSimulationLocked(): boolean {
  return process.env.WAREHOUSE_SIMULATION_LOCKED?.trim().toLowerCase() !== "false";
}
