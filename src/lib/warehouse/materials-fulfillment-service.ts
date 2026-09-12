/**
 * Deterministic preparation for a Materials Planner fulfillment.
 *
 * The planner supplies catalog-grounded requirements, but it never chooses a
 * physical bin. This service re-reads current inventory and selects enough
 * OCCUPIED bins to cover every requested quantity before the first retrieval
 * is attempted. If any SKU is short, the whole plan is rejected without
 * moving a bin; partially starting a build kit would be surprising and hard
 * to recover from safely.
 */
import { compareBinsInShelfOrder } from "./bin-layout";
import { getInventoryForPart } from "./inventory-service";
import type { MaterialRequirement } from "./materials-plan-service";

export interface MaterialsFulfillmentBin {
  sku: string;
  binCode: string;
  recordedQuantity: number;
  requiredQuantity: number;
}

export interface MaterialsFulfillmentShortage {
  sku: string;
  required: number;
  available: number;
}

export type MaterialsFulfillmentPlan =
  | {
      ok: true;
      requirements: MaterialRequirement[];
      selectedBins: MaterialsFulfillmentBin[];
    }
  | {
      ok: false;
      reason: "materials_shortage" | "materials_plan_invalid";
      message: string;
      shortages: MaterialsFulfillmentShortage[];
    };

/** Keep one approved workflow bounded even if an upstream model misbehaves. */
export const MAX_MATERIALS_FULFILLMENT_BINS = 20;

function aggregateRequirements(
  requirements: readonly MaterialRequirement[],
): MaterialRequirement[] {
  const bySku = new Map<string, MaterialRequirement>();
  for (const requirement of requirements) {
    const sku = requirement.sku.trim().toUpperCase();
    const existing = bySku.get(sku);
    bySku.set(sku, {
      sku,
      purpose: existing
        ? `${existing.purpose}; ${requirement.purpose.trim()}`
        : requirement.purpose.trim(),
      category: existing?.category ?? requirement.category.trim(),
      quantity: (existing?.quantity ?? 0) + requirement.quantity,
    });
  }
  return [...bySku.values()];
}

export async function prepareMaterialsFulfillment(
  requirements: readonly MaterialRequirement[],
): Promise<MaterialsFulfillmentPlan> {
  const normalized = aggregateRequirements(requirements);
  if (normalized.length === 0) {
    return {
      ok: false,
      reason: "materials_plan_invalid",
      message: "The materials plan contains no requirements to fulfill.",
      shortages: [],
    };
  }

  const selectedBins: MaterialsFulfillmentBin[] = [];
  const shortages: MaterialsFulfillmentShortage[] = [];

  for (const requirement of normalized) {
    let locations: Awaited<ReturnType<typeof getInventoryForPart>>["locations"] = [];
    try {
      const inventory = await getInventoryForPart(requirement.sku);
      locations = inventory.locations;
    } catch {
      shortages.push({
        sku: requirement.sku,
        required: requirement.quantity,
        available: 0,
      });
      continue;
    }

    const stocked = locations
      .filter(
        (location) =>
          location.binStatus === "OCCUPIED" && location.quantity > 0,
      )
      .sort((left, right) =>
        compareBinsInShelfOrder(
          { code: left.binCode },
          { code: right.binCode },
        ),
      );
    const available = stocked.reduce(
      (sum, location) => sum + location.quantity,
      0,
    );

    if (available < requirement.quantity) {
      shortages.push({
        sku: requirement.sku,
        required: requirement.quantity,
        available,
      });
      continue;
    }

    let covered = 0;
    for (const location of stocked) {
      if (covered >= requirement.quantity) break;
      selectedBins.push({
        sku: requirement.sku,
        binCode: location.binCode,
        recordedQuantity: location.quantity,
        requiredQuantity: requirement.quantity,
      });
      covered += location.quantity;
    }
  }

  if (shortages.length > 0) {
    return {
      ok: false,
      reason: "materials_shortage",
      message: `The materials plan cannot start because ${shortages
        .map(
          (shortage) =>
            `${shortage.sku} needs ${shortage.required}, but ${shortage.available} are shelf-available`,
        )
        .join("; ")}. No bin moved.`,
      shortages,
    };
  }

  if (selectedBins.length > MAX_MATERIALS_FULFILLMENT_BINS) {
    return {
      ok: false,
      reason: "materials_plan_invalid",
      message: `The plan selects ${selectedBins.length} bins; at most ${MAX_MATERIALS_FULFILLMENT_BINS} can be fulfilled in one workflow. No bin moved.`,
      shortages: [],
    };
  }

  return { ok: true, requirements: normalized, selectedBins };
}
