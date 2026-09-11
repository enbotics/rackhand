/**
 * The materials-plan stock check: given a Planner's requirements list, audits
 * every bin currently holding a required SKU and reports required/available/
 * status per SKU. Read-only in effect — it verifies stock, it never moves
 * anything into or out of the warehouse.
 *
 * Reuses the existing inventory-audit machinery end to end (runInventoryAudit,
 * the InventoryAuditRun/BinAudit progress rows, the PLAN_VERIFICATION trigger's
 * automatic capture with per-bin operator acknowledgement) rather than building a parallel
 * audit path — the only new thing here is the SKU-level requirements
 * bookkeeping and the final required-vs-available comparison.
 */
import { prisma } from "./db";
import { getInventoryForPart } from "./inventory-service";
import {
  runInventoryAudit,
  type InventoryAuditTrigger,
} from "./inventory-audit-service";
import { getInventoryAuditRunView } from "./dashboard-service";
import { activeAuditBinCode } from "./rack-arm-state";
import type { MaterialsPlanCheckView } from "./dashboard-types";

export interface MaterialRequirement {
  sku: string;
  purpose: string;
  category: string;
  quantity: number;
}

export interface MaterialAvailabilityResult {
  sku: string;
  required: number;
  available: number;
  status: "AVAILABLE" | "SHORTAGE";
}

const PLAN_VERIFICATION_TRIGGER: InventoryAuditTrigger = "PLAN_VERIFICATION";

/**
 * Records a check with no real sweep behind it — either nothing was stocked
 * anywhere, or the sweep couldn't even start (e.g. a real audit already owns
 * the system-wide lock). Every requirement is reported SHORTAGE at 0
 * available: conservative, and — critically — still a TERMINAL, renderable
 * result. The schema requires every MaterialsPlanCheck to reference a real
 * InventoryAuditRun, so this creates a 0-bin COMPLETED one rather than
 * skipping the row; without a row, the client's poll would find nothing and
 * stay at its fast cadence forever with no card ever appearing.
 */
async function recordUnstartedCheck(
  requirements: MaterialRequirement[],
  ownerSessionId: string | null,
): Promise<{ results: MaterialAvailabilityResult[] }> {
  const results: MaterialAvailabilityResult[] = requirements.map((req) => ({
    sku: req.sku,
    required: req.quantity,
    available: 0,
    status: "SHORTAGE",
  }));
  await prisma.materialsPlanCheck.create({
    data: {
      ownerSessionId,
      requirementsJson: JSON.stringify(requirements),
      auditRun: {
        create: {
          trigger: PLAN_VERIFICATION_TRIGGER,
          status: "COMPLETED",
          binsPlanned: 0,
          binsCompleted: 0,
          completedAt: new Date(),
        },
      },
      resultJson: JSON.stringify(results),
      completedAt: new Date(),
    },
  });
  return { results };
}

/**
 * Runs the sweep and writes the final comparison onto the MaterialsPlanCheck
 * row it creates. Awaited end to end — callers that want this to happen
 * off the request/response path (see verify-materials-availability.ts) are
 * responsible for scheduling the call itself, not this function. Never
 * throws — every path, including a sweep that can't start at all, ends in a
 * terminal MaterialsPlanCheck row so the client always has something to show.
 */
export async function runMaterialsAvailabilityCheck(input: {
  requirements: MaterialRequirement[];
  ownerSessionId: string | null;
}): Promise<{ results: MaterialAvailabilityResult[] }> {
  const requirements = input.requirements;

  // Resolve each requirement to the real, currently-stocked bins holding it.
  // A requirement whose SKU no longer resolves (stale by the time the sweep
  // runs) or has no stock anywhere is an honest SHORTAGE, not an error.
  const binCodesBySku = new Map<string, string[]>();
  const skuByBinCode = new Map<string, string>();
  for (const req of requirements) {
    try {
      const summary = await getInventoryForPart(req.sku);
      const stockedBinCodes = summary.locations
        .filter((location) => location.binStatus === "OCCUPIED" && location.quantity > 0)
        .map((location) => location.binCode);
      binCodesBySku.set(req.sku, stockedBinCodes);
      for (const code of stockedBinCodes) skuByBinCode.set(code, req.sku);
    } catch {
      binCodesBySku.set(req.sku, []);
    }
  }

  const allBinCodes = [...new Set([...skuByBinCode.keys()])];

  // Nothing to audit: every requirement is stocked nowhere.
  if (allBinCodes.length === 0) {
    return recordUnstartedCheck(requirements, input.ownerSessionId);
  }

  let runResult: Awaited<ReturnType<typeof runInventoryAudit>>;
  try {
    runResult = await runInventoryAudit({
      trigger: PLAN_VERIFICATION_TRIGGER,
      binCodes: allBinCodes,
      ownerSessionId: input.ownerSessionId,
    });
  } catch (error) {
    // Most commonly InventoryAuditAlreadyRunningError — a real audit already
    // owns the system-wide activeKey lock. Whatever the cause, the sweep
    // never ran, so this reports conservatively rather than leaving the
    // operator's poll with nothing to find.
    console.error("[materials-plan] sweep could not start:", error);
    return recordUnstartedCheck(requirements, input.ownerSessionId);
  }

  // Sum verified quantity per SKU straight from the sweep's own per-bin
  // results — a FAILED capture has observedQuantity: null and contributes 0,
  // which is the conservative, never-overstate-availability choice.
  const availableBySku = new Map<string, number>();
  for (const binResult of runResult.results) {
    const sku = skuByBinCode.get(binResult.binCode);
    if (!sku) continue;
    // A skipped/rejected observation is not verified stock. Do not let a
    // visible but explicitly dismissed count satisfy a materials request.
    if (!["VERIFIED", "AUTO_RECONCILED", "CONFIRMED"].includes(binResult.status)) {
      continue;
    }
    const current = availableBySku.get(sku) ?? 0;
    availableBySku.set(sku, current + (binResult.observedQuantity ?? 0));
  }

  const results: MaterialAvailabilityResult[] = requirements.map((req) => {
    const available = availableBySku.get(req.sku) ?? 0;
    return {
      sku: req.sku,
      required: req.quantity,
      available,
      status: available >= req.quantity ? "AVAILABLE" : "SHORTAGE",
    };
  });

  await prisma.materialsPlanCheck.create({
    data: {
      ownerSessionId: input.ownerSessionId,
      requirementsJson: JSON.stringify(requirements),
      auditRunId: runResult.auditRunId,
      resultJson: JSON.stringify(results),
      completedAt: new Date(),
    },
  });

  return { results };
}

/** This session's own latest build-plan check, for the polling endpoint. */
export async function getLatestMaterialsPlanCheck(
  ownerSessionId: string,
): Promise<MaterialsPlanCheckView | null> {
  const check = await prisma.materialsPlanCheck.findFirst({
    where: { ownerSessionId },
    orderBy: { createdAt: "desc" },
  });
  if (!check) return null;

  const auditView = await getInventoryAuditRunView(check.auditRunId);
  const requirements = JSON.parse(check.requirementsJson) as MaterialRequirement[];
  const results = check.resultJson
    ? (JSON.parse(check.resultJson) as MaterialAvailabilityResult[])
    : null;

  return {
    id: check.id,
    requirements,
    status: auditView?.status ?? "FAILED",
    binsPlanned: auditView?.binsPlanned ?? 0,
    binsCompleted: auditView?.binsCompleted ?? 0,
    currentBinCode: activeAuditBinCode(auditView),
    results,
    createdAt: check.createdAt.getTime(),
    completedAt: check.completedAt?.getTime() ?? null,
  };
}
