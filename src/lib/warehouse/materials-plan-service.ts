/**
 * Read compatibility for materials-plan stock checks created by releases prior
 * to approval-gated fulfillment.
 *
 * New plans never create these rows: materials_planner is followed by
 * fulfill_materials_plan, whose deterministic preflight revalidates inventory
 * before any approved movement. Keeping this projection lets an operator read
 * a historical report without keeping the retired background-audit capability
 * executable in production.
 */
import { prisma } from "./db";
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

/** This session's latest historical build-plan check, for legacy rendering. */
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
