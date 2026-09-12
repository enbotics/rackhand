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
import {
  getBinVerificationEvidence,
  type BinVerificationEvidence,
} from "./bin-verification-evidence";
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

export interface MaterialsVerificationTarget {
  sku: string;
  binCode: string;
  recordedQuantity: number;
  evidence: BinVerificationEvidence;
}

export type MaterialsFulfillmentPlan =
  | {
      ok: true;
      requirements: MaterialRequirement[];
      selectedBins: MaterialsFulfillmentBin[];
    }
  | {
      ok: false;
      reason:
        | "materials_shortage"
        | "materials_plan_invalid"
        | "materials_verification_required"
        | "materials_verification_incomplete";
      message: string;
      shortages: MaterialsFulfillmentShortage[];
      verificationTargets?: MaterialsVerificationTarget[];
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
  options: { excludeVerificationBinCodes?: readonly string[] } = {},
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
  const verificationTargets: MaterialsVerificationTarget[] = [];
  const verificationBlocked: MaterialsFulfillmentShortage[] = [];
  const excluded = new Set(
    (options.excludeVerificationBinCodes ?? []).map((code) => code.trim().toUpperCase()),
  );
  const locationsBySku = new Map<
    string,
    Awaited<ReturnType<typeof getInventoryForPart>>["locations"]
  >();

  for (const requirement of normalized) {
    try {
      const inventory = await getInventoryForPart(requirement.sku);
      locationsBySku.set(requirement.sku, inventory.locations);
    } catch {
      locationsBySku.set(requirement.sku, []);
    }
  }

  const evidenceByBin = await getBinVerificationEvidence(
    [...locationsBySku.values()]
      .flat()
      .filter((location) => location.binStatus === "OCCUPIED" && location.quantity > 0)
      .map((location) => location.binCode),
  );

  for (const requirement of normalized) {
    const locations = locationsBySku.get(requirement.sku) ?? [];

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

    const trusted = stocked.filter(
      (location) => evidenceByBin.get(location.binCode)?.trusted === true,
    );
    const trustedAvailable = trusted.reduce((sum, location) => sum + location.quantity, 0);
    if (trustedAvailable < requirement.quantity) {
      let potential = trustedAvailable;
      const uncertain = stocked
        .filter(
          (location) =>
            evidenceByBin.get(location.binCode)?.trusted !== true &&
            !excluded.has(location.binCode),
        )
        // Largest bins first minimizes physical audit trips. Shelf order is
        // the stable tie-breaker, not the primary selection rule.
        .sort(
          (left, right) =>
            right.quantity - left.quantity ||
            compareBinsInShelfOrder({ code: left.binCode }, { code: right.binCode }),
        );
      for (const location of uncertain) {
        if (potential >= requirement.quantity) break;
        verificationTargets.push({
          sku: requirement.sku,
          binCode: location.binCode,
          recordedQuantity: location.quantity,
          evidence:
            evidenceByBin.get(location.binCode) ?? {
              binCode: location.binCode,
              state: "NEVER_VERIFIED",
              trusted: false,
              lastVerifiedAt: null,
              lastInventoryChangeAt: null,
              latestAuditStatus: null,
              reason: "no persisted verification evidence was found",
            },
        });
        potential += location.quantity;
      }
      if (potential < requirement.quantity) {
        verificationBlocked.push({
          sku: requirement.sku,
          required: requirement.quantity,
          available: trustedAvailable,
        });
      }
      continue;
    }

    let covered = 0;
    for (const location of trusted) {
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

  if (verificationBlocked.length > 0) {
    return {
      ok: false,
      reason: "materials_verification_incomplete",
      message: `Fresh evidence could not establish enough stock for ${verificationBlocked
        .map(
          (item) =>
            `${item.sku}: ${item.available} verified of ${item.required} required`,
        )
        .join("; ")}. No bin was retrieved.`,
      shortages: verificationBlocked,
    };
  }

  if (verificationTargets.length > 0) {
    return {
      ok: false,
      reason: "materials_verification_required",
      message: `${verificationTargets.length} relevant bin${verificationTargets.length === 1 ? "" : "s"} need fresh verification before fulfillment. No unrelated bin was selected.`,
      shortages: [],
      verificationTargets,
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
