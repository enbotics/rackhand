import type { TodayPlanAnalysisResultView } from "./analysis-types";

type PhysicalCount = NonNullable<TodayPlanAnalysisResultView["physicalCounts"]>[number];

/** Count each bin once, replacing recorded stock with this run's physical evidence. */
export function physicalAvailability(
  sku: string,
  locations: Array<{ binCode: string; quantity: number; binStatus: string; trusted: boolean }>,
  observations: PhysicalCount[],
): number | null {
  const checked = new Map(observations.filter((item) => item.sku === sku).map((item) => [item.binCode, item]));
  let total = 0;
  let complete = true;
  for (const location of locations) {
    const observation = checked.get(location.binCode);
    if (observation) {
      if (observation.usable && observation.observedQuantity !== null) total += observation.observedQuantity;
      else complete = false;
      checked.delete(location.binCode);
    } else if (location.binStatus === "OCCUPIED" && location.quantity > 0) {
      if (location.trusted) total += location.quantity;
      else complete = false;
    }
  }
  // A verified zero can remove an inventory row, so include observed bins no longer listed.
  for (const observation of checked.values()) {
    if (observation.usable && observation.observedQuantity !== null) total += observation.observedQuantity;
    else complete = false;
  }
  return complete ? total : null;
}
