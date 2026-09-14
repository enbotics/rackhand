import { prisma } from "@/lib/warehouse/db";
import { assessBinInspection, parseInspectionForeignObjects } from "@/lib/warehouse/bin-inspection-service";
import { AUDIT_CAPTURE_CONFIDENCE_THRESHOLD } from "@/lib/warehouse/audit-capture-types";
import { auditScaleCheck } from "@/lib/warehouse/audit-scale-service";
import type { AuditVisionResult } from "@/lib/warehouse/audit-types";
import type { TodayPlanAnalysisResultView } from "./analysis-types";

export async function readPhysicalCount(
  binAuditId: string,
  sku: string,
  recordedQuantity: number,
): Promise<NonNullable<TodayPlanAnalysisResultView["physicalCounts"]>[number]> {
  const audit = await prisma.binAudit.findUniqueOrThrow({
    where: { id: binAuditId }, include: { bin: true, capture: true, expectedPart: true },
  });
  const job = await prisma.cameraCaptureJob.findFirst({
    where: { binAuditId, evidenceUrl: audit.evidenceUrl ?? "", status: { in: ["PROCESSING", "COMPLETED"] } },
    orderBy: { requestedAt: "desc" },
    select: { totalWeightGrams: true, weightSource: true, capturedAt: true },
  });
  const scale = await auditScaleCheck({
    part: audit.expectedPart,
    totalWeightGrams: job?.totalWeightGrams, weightSource: job?.weightSource,
  });
  const assessment = assessBinInspection({
    observedCount: scale.estimatedQuantity, countConfidence: audit.countConfidence ?? 0,
    countable: audit.countable ?? false, expectedPartPresent: audit.expectedPartPresent ?? false,
    foreignObjectSuspected: audit.foreignObjectSuspected ?? false,
    foreignObjects: parseInspectionForeignObjects(audit.capture?.foreignObjectsJson ?? null),
    occlusion: (audit.occlusion ?? "HIGH") as AuditVisionResult["occlusion"], notes: audit.notes ?? "",
  }, { confidenceThreshold: AUDIT_CAPTURE_CONFIDENCE_THRESHOLD, capacity: audit.bin.capacity,
       requireExpectedPart: audit.expectedPartId !== null });
  return {
    sku, binCode: audit.bin.code, recordedQuantity, observedQuantity: scale.estimatedQuantity,
    usable: assessment.gate === "CLEAR" && scale.status === "VERIFIED" && audit.status !== "FAILED",
    inventoryUpdated: audit.inventoryUpdated, scale,
  };
}
