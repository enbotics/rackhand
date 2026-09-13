import { prisma } from "./db";
import { checkAuditScale } from "./audit-scale";

export async function auditScaleCheck(input: {
  binId: string;
  partId: string | null;
  capturedAt: Date;
  observedQuantity: number | null;
  totalWeightGrams?: number | null;
  weightSource?: string | null;
}) {
  const baseline = input.partId && input.weightSource === "SCALE"
    ? await prisma.movement.findFirst({
        where: {
          destinationBinId: input.binId, partId: input.partId,
          type: "PUTAWAY", status: "COMPLETED", weightSource: "SCALE",
          completedAt: { lte: input.capturedAt }, unitWeightGrams: { gt: 0 },
        },
        orderBy: { completedAt: "desc" },
        select: { unitWeightGrams: true, tareWeightGrams: true, weightSource: true },
      })
    : null;
  return checkAuditScale(input.observedQuantity, input, baseline);
}
