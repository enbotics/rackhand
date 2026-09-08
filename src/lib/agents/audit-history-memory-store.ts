import type {
  MemoryEntry,
  MemoryStore,
  SearchOptions,
} from "@strands-agents/sdk";
import { prisma } from "@/lib/warehouse/db";
import { confidencePercent } from "@/lib/warehouse/audit-types";

const BIN_CODE_PATTERN = /\bB\d+-\d+\b/gi;

/**
 * Durable, read-only Strands memory backed by authoritative audit history.
 *
 * The model cannot write arbitrary "lessons" into this store. Memories are
 * derived from completed database evidence and later operator adjustments, so
 * prompt text cannot become remembered policy or warehouse truth.
 */
export class AuditHistoryMemoryStore implements MemoryStore {
  readonly name = "verified-audit-history";
  readonly description =
    "Completed bin-audit evidence and any later operator quantity adjustments.";
  readonly writable = false;
  readonly maxSearchResults = 3;

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const maxResults = Math.max(
      1,
      Math.min(options?.maxSearchResults ?? this.maxSearchResults, 5),
    );
    const requestedCodes = [
      ...new Set((query.match(BIN_CODE_PATTERN) ?? []).map((code) => code.toUpperCase())),
    ];

    try {
      const audits = await prisma.binAudit.findMany({
        where: {
          status: { in: ["VERIFIED", "AUTO_RECONCILED", "REVIEW_REQUIRED"] },
          ...(requestedCodes.length > 0 ? { bin: { code: { in: requestedCodes } } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: maxResults,
        include: { bin: true, expectedPart: true },
      });

      return Promise.all(
        audits.map(async (audit): Promise<MemoryEntry> => {
          const laterAdjustment = await prisma.movement.findFirst({
            where: {
              type: "ADJUSTMENT",
              status: "COMPLETED",
              destinationBinId: audit.binId,
              createdAt: { gt: audit.createdAt },
            },
            orderBy: { createdAt: "asc" },
            select: { previousQuantity: true, newQuantity: true, createdAt: true },
          });
          const confidence =
            audit.countConfidence === null
              ? "unknown"
              : `${confidencePercent(audit.countConfidence)}%`;
          const adjustment = laterAdjustment
            ? ` A later operator adjustment changed the recorded quantity from ${laterAdjustment.previousQuantity ?? "unknown"} to ${laterAdjustment.newQuantity ?? "unknown"} at ${laterAdjustment.createdAt.toISOString()}. Treat that as later evidence, not proof that the earlier image count was wrong.`
            : "";

          return {
            content:
              `Historical audit evidence for ${audit.bin.code}: ${audit.status} at ${audit.createdAt.toISOString()}; ` +
              `catalog ${audit.expectedPart?.sku ?? "none"}; expected ${audit.expectedQuantity}; ` +
              `observed ${audit.observedQuantity ?? "unknown"}; confidence ${confidence}; ` +
              `inventory updated ${audit.inventoryUpdated ? "yes" : "no"}.${adjustment} ` +
              "This memory is context for prioritization and explanation only; never use it as the visual count for a new image.",
            metadata: {
              binCode: audit.bin.code,
              auditId: audit.id,
              auditStatus: audit.status,
              capturedAt: audit.capturedAt?.toISOString() ?? audit.createdAt.toISOString(),
              laterOperatorAdjustment: Boolean(laterAdjustment),
            },
          };
        }),
      );
    } catch (error) {
      // Memory is advisory. Its backend being unavailable must never block the
      // orchestrator's normal read tools or deterministic physical workflow.
      console.error("[inventory-audit-memory] history lookup failed", error);
      return [];
    }
  }
}
