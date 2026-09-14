import { prisma } from "./db";
import { compareBinsInShelfOrder } from "./bin-layout";
import { runInventoryAuditGraph } from "./graphs/inventory-audit-graph";
import type { BinAuditResult, InventoryAuditRunResult } from "./audit-types";
import type { InventoryAuditRun } from "@/generated/prisma/client";
import { observeDailyBinActivity } from "./audit-activity-service";
import {
  getActiveInventoryAuditSummary,
  InventoryAuditAlreadyRunningError,
  recoverStaleInventoryAudit,
} from "./audit-recovery-service";
import { confirmBinAuditObservation } from "./audit-bin-service";
import { withWarehouseHardwareLease } from "./hardware-lease";

export type InventoryAuditTrigger = "CLIENT" | "TRUSTED_INTERNAL";

function isUniqueViolation(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "P2002";
}

export async function runInventoryAudit(input: {
  binCode?: string;
  trigger: InventoryAuditTrigger;
  /** Owner of interactive capture decisions for client-visible workflows. */
  ownerSessionId?: string | null;
  /** Preserve inventory and settle discrepancies without a later confirmation card. */
  reviewPolicy?: "INTERACTIVE" | "REPORT_ONLY";
}): Promise<InventoryAuditRunResult> {
  const requestedBinCode = input.binCode?.trim().toUpperCase();
  // A process restart can interrupt the in-memory wait while leaving the
  // durable ACTIVE lock behind. Recover only rows whose own deadline plus a
  // safety grace has elapsed; a genuinely live audit remains untouched.
  await recoverStaleInventoryAudit();
  if (input.trigger === "TRUSTED_INTERNAL") {
    if (!requestedBinCode) throw new Error("trusted_audit_bin_required");
    const observation = await observeDailyBinActivity();
    const selected = observation.candidates.find(
      (candidate) => candidate.binCode === requestedBinCode,
    );
    if (!selected?.eligibleNow) throw new Error("trusted_audit_candidate_ineligible");
  }
  let run: InventoryAuditRun;
  try {
    run = await prisma.inventoryAuditRun.create({
      data: {
        trigger: input.trigger,
        status: "RUNNING",
        requestedBinCode: requestedBinCode || null,
        activeKey: "ACTIVE",
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const active = await getActiveInventoryAuditSummary();
      if (active) {
        throw new InventoryAuditAlreadyRunningError(
          active,
          requestedBinCode || null,
        );
      }
      throw new Error("audit_already_running");
    }
    throw error;
  }

  const results: BinAuditResult[] = [];
  try {
    const bins = requestedBinCode
      ? await prisma.bin.findMany({
          where: { code: requestedBinCode },
          include: { inventory: { where: { quantity: { gt: 0 } }, include: { part: true } } },
        })
      : await prisma.bin.findMany({
          where: { status: { in: ["AVAILABLE", "OCCUPIED"] } },
          include: { inventory: { where: { quantity: { gt: 0 } }, include: { part: true } } },
        });
    bins.sort(compareBinsInShelfOrder);
    if (bins.length === 0) {
      throw new Error(requestedBinCode ? "bin_not_found" : "no_auditable_bins");
    }

    await prisma.inventoryAuditRun.update({
      where: { id: run.id },
      data: { binsPlanned: bins.length },
    });

    for (const bin of bins) {
      const inventory = bin.inventory[0] ?? null;
      const expectedQuantity = bin.inventory.reduce((sum, row) => sum + row.quantity, 0);
      const binAudit = await prisma.binAudit.create({
        data: {
          auditRunId: run.id,
          binId: bin.id,
          expectedPartId: inventory?.partId ?? null,
          expectedQuantity,
          status: "PENDING",
        },
      });
      let result = await withWarehouseHardwareLease(() => runInventoryAuditGraph({
        binAuditId: binAudit.id,
        ownerSessionId: input.ownerSessionId,
      }));
      if (input.reviewPolicy === "REPORT_ONLY" && result.status === "REVIEW_REQUIRED") {
        await confirmBinAuditObservation(result.binAuditId, "DISMISS");
        result = { ...result, status: "DISMISSED" };
      }
      results.push(result);

      const verifiedBins = results.filter((item) => item.status === "VERIFIED").length;
      const reconciledBins = results.filter((item) => item.status === "AUTO_RECONCILED").length;
      const reviewRequiredBins = results.filter(
        (item) => item.status === "REVIEW_REQUIRED" || item.status === "DISMISSED",
      ).length;
      const failedBins = results.filter((item) => item.status === "FAILED").length;
      await prisma.inventoryAuditRun.update({
        where: { id: run.id },
        data: {
          binsCompleted: results.length,
          verifiedBins,
          reconciledBins,
          reviewRequiredBins,
          failedBins,
        },
      });

      if (result.reason === "audit_return_failed") break;
    }

    const failedBins = results.filter((item) => item.status === "FAILED").length;
    const reviewRequiredBins = results.filter(
      (item) => item.status === "REVIEW_REQUIRED" || item.status === "DISMISSED",
    ).length;
    const reconciledBins = results.filter((item) => item.status === "AUTO_RECONCILED").length;
    const verifiedBins = results.filter((item) => item.status === "VERIFIED").length;
    const returnFailed = results.some((item) => item.reason === "audit_return_failed");
    const status = returnFailed
      ? "FAILED"
      : failedBins > 0 || reviewRequiredBins > 0
        ? "COMPLETED_WITH_ISSUES"
        : "COMPLETED";
    await prisma.inventoryAuditRun.update({
      where: { id: run.id },
      data: { status, activeKey: null, completedAt: new Date() },
    });
    return {
      auditRunId: run.id,
      status,
      binsPlanned: bins.length,
      binsCompleted: results.length,
      verifiedBins,
      reconciledBins,
      reviewRequiredBins,
      failedBins,
      results,
    };
  } catch (error) {
    await prisma.inventoryAuditRun.update({
      where: { id: run.id },
      data: { status: "FAILED", activeKey: null, completedAt: new Date() },
    }).catch(() => {});
    throw error;
  }
}

export async function getLatestInventoryAudit() {
  return prisma.inventoryAuditRun.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      binAudits: {
        orderBy: { createdAt: "asc" },
        include: { bin: true, expectedPart: true },
      },
    },
  });
}

/** Durable prior audit/snapshot history, optionally scoped to one bin. */
export async function getInventoryAuditHistory(input: {
  binCode?: string;
  limit?: number;
}) {
  const binCode = input.binCode?.trim().toUpperCase();
  const limit = Number.isInteger(input.limit)
    ? Math.max(1, Math.min(input.limit ?? 10, 20))
    : 10;
  return prisma.inventoryAuditRun.findMany({
    where: binCode ? { binAudits: { some: { bin: { code: binCode } } } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      binAudits: {
        where: binCode ? { bin: { code: binCode } } : undefined,
        orderBy: { createdAt: "asc" },
        include: { bin: true, expectedPart: true },
      },
    },
  });
}
