/**
 * Deterministic preparation for a Materials Planner fulfillment.
 *
 * The planner supplies catalog-grounded requirements, but it never chooses a
 * physical bin. This service re-reads current inventory and selects enough
 * OCCUPIED bins to cover every requested quantity before the first retrieval
 * is attempted. Callers choose whether selection requires current verification
 * evidence: plan audits do, while an explicitly approved preparation job does
 * not because each checked-out bin is verified by its required photo return.
 * If any SKU is short, the whole plan is rejected without moving a bin.
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
  /** Present in analysis mode when this bin was selected from trusted evidence. */
  verification?: BinVerificationEvidence;
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
      requirements: MaterialRequirement[];
      /** Bins already proven sufficient for other requirements in this report. */
      selectedBins: MaterialsFulfillmentBin[];
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
  options: {
    excludeVerificationBinCodes?: readonly string[];
    /** Analysis mode: finish assessing other SKUs after one known shortage. */
    continueAfterKnownShortage?: boolean;
    /**
     * Audit/report mode requires current evidence. A physical preparation job
     * sets this false: recorded shelf stock selects every requested bin, and
     * the existing fresh-photo return reconciles it after the engineer uses it.
     */
    requireTrustedEvidence?: boolean;
  } = {},
): Promise<MaterialsFulfillmentPlan> {
  const normalized = aggregateRequirements(requirements);
  if (normalized.length === 0) {
    return {
      ok: false,
      reason: "materials_plan_invalid",
      message: "The materials plan contains no requirements to fulfill.",
      requirements: normalized,
      selectedBins: [],
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

    if (options.requireTrustedEvidence === false) {
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
      const verification = evidenceByBin.get(location.binCode);
      selectedBins.push({
        sku: requirement.sku,
        binCode: location.binCode,
        recordedQuantity: location.quantity,
        requiredQuantity: requirement.quantity,
        ...(verification ? { verification } : {}),
      });
      covered += location.quantity;
    }
  }

  // Physical fulfillment remains fail-fast by default: there is no reason to
  // audit more bins for an all-or-nothing retrieval that cannot start. The
  // read-only Sheet analysis opts into completing every requirement instead.
  if (shortages.length > 0 && !options.continueAfterKnownShortage) {
    return {
      ok: false,
      reason: "materials_shortage",
      message: `The materials plan cannot start because ${shortages
        .map(
          (shortage) =>
            `${shortage.sku} needs ${shortage.required}, but ${shortage.available} are shelf-available`,
        )
        .join("; ")}. No bin moved.`,
      requirements: normalized,
      selectedBins,
      shortages,
    };
  }

  if (verificationTargets.length > 0) {
    return {
      ok: false,
      reason: "materials_verification_required",
      message: `${verificationTargets.length} relevant bin${verificationTargets.length === 1 ? "" : "s"} still need fresh verification before the report is final.`,
      requirements: normalized,
      selectedBins,
      shortages: [...shortages, ...verificationBlocked],
      verificationTargets,
    };
  }

  const unavailable = [...shortages, ...verificationBlocked];
  if (unavailable.length > 0) {
    const reason = shortages.length > 0
      ? "materials_shortage" as const
      : "materials_verification_incomplete" as const;
    return {
      ok: false,
      reason,
      message: `Analysis finished with ${unavailable.length} unavailable material${unavailable.length === 1 ? "" : "s"}. Ready bins remain listed for operation; unavailable materials will not be used.`,
      requirements: normalized,
      selectedBins,
      shortages: unavailable,
    };
  }

  if (selectedBins.length > MAX_MATERIALS_FULFILLMENT_BINS) {
    return {
      ok: false,
      reason: "materials_plan_invalid",
      message: `The plan selects ${selectedBins.length} bins; at most ${MAX_MATERIALS_FULFILLMENT_BINS} can be fulfilled in one workflow. No bin moved.`,
      requirements: normalized,
      selectedBins,
      shortages: [],
    };
  }

  return { ok: true, requirements: normalized, selectedBins };
}
