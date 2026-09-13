/**
 * Composes the authoritative warehouse snapshot the dashboard renders
 * (Milestone 10).
 *
 * READ ONLY. Nothing here creates, updates or deletes a row, and it holds no
 * business rules of its own: no availability decision, no quantity
 * arithmetic beyond summing what the database already stores, no matching, no
 * reservation. Deciding what may happen to a bin stays in the putaway and
 * retrieval services where the transactions are; this only reports what IS.
 *
 * It exists so the browser never has to join Inventory to Part to Bin itself.
 * A React component that did those joins would be a second, silent
 * implementation of warehouse state, and the moment it disagreed with the
 * database the operator would be looking at a warehouse that does not exist.
 */
import { prisma } from "./db";
import type {
  BinSnapshotView,
  BinView,
  InventoryAuditView,
  InventoryRowView,
  MovementRowView,
  WarehouseOverview,
} from "./dashboard-types";
import { isSimulationEvidenceUrl } from "./simulation-evidence";
import { confidencePercent } from "./audit-types";
import { getAuditCaptureMode, isSimulationEligibleBin } from "./audit-capture-mode";
import {
  calculatePutawayWeight,
  configuredFallbackTotalWeightGrams,
} from "./putaway-weight";
import type { BinStatus, MovementStatus, MovementType } from "./types";
import type { Prisma } from "@/generated/prisma/client";

const AUDIT_RUN_WITH_BINS = {
  binAudits: {
    orderBy: { createdAt: "asc" },
    include: { bin: true, expectedPart: true },
  },
} satisfies Prisma.InventoryAuditRunInclude;

type AuditRunWithBins = Prisma.InventoryAuditRunGetPayload<{
  include: typeof AUDIT_RUN_WITH_BINS;
}>;

function auditMovementPhase(value: string | null) {
  return value === "TO_SCAN" || value === "AT_SCAN" || value === "RETURNING"
    ? value
    : null;
}

/**
 * Shared with the legacy materials-plan endpoint, whose historical stock
 * checks referenced InventoryAuditRun rows. One mapping keeps those durable
 * records renderable without retaining their retired execution path.
 */
export function toInventoryAuditView(run: AuditRunWithBins): InventoryAuditView {
  return {
    auditRunId: run.id,
    trigger: run.trigger,
    status: run.status,
    requestedBinCode: run.requestedBinCode,
    binsPlanned: run.binsPlanned,
    binsCompleted: run.binsCompleted,
    verifiedBins: run.verifiedBins,
    reconciledBins: run.reconciledBins,
    reviewRequiredBins: run.reviewRequiredBins,
    failedBins: run.failedBins,
    startedAt: run.startedAt.getTime(),
    completedAt: run.completedAt?.getTime() ?? null,
    bins: run.binAudits.map((audit) => ({
      captureMode: isSimulationEvidenceUrl(audit.evidenceUrl) ? "SIMULATION" as const : "PROD" as const,
      binAuditId: audit.id,
      binCode: audit.bin.code,
      sku: audit.expectedPart?.sku ?? null,
      status: audit.status,
      movementPhase: auditMovementPhase(audit.movementPhase),
      movementPhaseStartedAt: audit.movementPhaseStartedAt?.getTime() ?? null,
      expectedQuantity: audit.expectedQuantity,
      observedQuantity: audit.observedQuantity,
      confidencePercent:
        audit.countConfidence === null ? null : confidencePercent(audit.countConfidence),
      inventoryUpdated: audit.inventoryUpdated,
      previousQuantity: audit.previousQuantity,
      newQuantity: audit.newQuantity,
      evidenceUrl: audit.evidenceUrl,
      priorEvidenceUrl: audit.priorEvidenceUrl,
      awaitingConfirmation:
        audit.status === "REVIEW_REQUIRED" &&
        audit.expectedPartId !== null &&
        audit.observedQuantity !== null,
      canApply:
        audit.errorCode === "audit_pending_confirmation" &&
        !isSimulationEvidenceUrl(audit.evidenceUrl),
      reason: audit.errorCode,
    })),
  };
}

export async function getInventoryAuditRunView(auditRunId: string): Promise<InventoryAuditView | null> {
  const run = await prisma.inventoryAuditRun.findUnique({
    where: { id: auditRunId },
    include: AUDIT_RUN_WITH_BINS,
  });
  return run ? toInventoryAuditView(run) : null;
}

/**
 * While AUDIT_CAPTURE_MODE=SIMULATION is active for a bin set up for it, the
 * dashboard shows that bin's curated demo baseline image instead of
 * whatever a real (or previously simulated) photo happens to be on file —
 * both the rack's "latest snapshot" and the bin-detail card's per-part
 * thumbnail. Flipping back to PROD immediately goes back to reporting the
 * real dynamically-computed photo, exactly as this file's own "read only,
 * reports what IS" rule intends: while simulating, the demo baseline IS
 * what this bin currently represents.
 */
function simulationSnapshotOverride(binCode: string): string | null {
  return getAuditCaptureMode() === "SIMULATION" && isSimulationEligibleBin(binCode)
    ? `/audit-simulation/${binCode}/snapshot.jpg`
    : null;
}

/** Enough history to read the last few operations at a glance, not an audit log. */
export const DEFAULT_MOVEMENT_LIMIT = 8;
const MAX_MOVEMENT_LIMIT = 50;

function clampMovementLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_MOVEMENT_LIMIT;
  return Math.min(limit, MAX_MOVEMENT_LIMIT);
}

/**
 * Most-recent-first per (partId, binId) pair, from COMPLETED putaways that
 * actually captured a photo. One extra query, done once for the whole
 * overview rather than per bin — the alternative is an N+1 lookup.
 */
async function loadPutawayImages(): Promise<Map<string, string>> {
  const rows = await prisma.movement.findMany({
    where: { type: "PUTAWAY", status: "COMPLETED", imageUrl: { not: null } },
    orderBy: { completedAt: "desc" },
    select: { partId: true, destinationBinId: true, imageUrl: true },
  });
  const byPartBin = new Map<string, string>();
  for (const row of rows) {
    if (!row.destinationBinId || !row.imageUrl) continue;
    const key = `${row.partId}:${row.destinationBinId}`;
    // Ordered by completedAt desc, so the first write for a key IS the latest.
    if (!byPartBin.has(key)) byPartBin.set(key, row.imageUrl);
  }
  return byPartBin;
}

/** Latest captured placement evidence per physical destination bin. */
async function loadLatestBinSnapshots(): Promise<Map<string, BinSnapshotView>> {
  const [rows, auditRows] = await Promise.all([
    prisma.movement.findMany({
      where: {
        destinationBinId: { not: null },
        verificationImageUrl: { not: null },
        verificationCapturedAt: { not: null },
      },
      orderBy: { verificationCapturedAt: "desc" },
      select: {
        id: true,
        destinationBinId: true,
        verificationImageUrl: true,
        verificationCapturedAt: true,
        status: true,
        quantity: true,
        newQuantity: true,
        totalWeightGrams: true,
        tareWeightGrams: true,
        netWeightGrams: true,
        unitWeightGrams: true,
        weightSource: true,
      },
    }),
    prisma.binAudit.findMany({
      where: { evidenceUrl: { not: null }, capturedAt: { not: null } },
      orderBy: { capturedAt: "desc" },
      select: {
        id: true,
        binId: true,
        evidenceUrl: true,
        capturedAt: true,
        status: true,
        countConfidence: true,
      },
    }),
  ]);
  const byBin = new Map<string, BinSnapshotView>();
  for (const row of rows) {
    if (
      !row.destinationBinId ||
      !row.verificationImageUrl ||
      !row.verificationCapturedAt ||
      byBin.has(row.destinationBinId)
    ) {
      continue;
    }
    const measuredQuantity = row.newQuantity ?? row.quantity;
    const legacyFallback = row.totalWeightGrams === null && measuredQuantity > 0
      ? calculatePutawayWeight(
          configuredFallbackTotalWeightGrams(),
          measuredQuantity,
        )
      : null;
    byBin.set(row.destinationBinId, {
      imageUrl: row.verificationImageUrl,
      capturedAt: row.verificationCapturedAt.getTime(),
      source: "PUTAWAY",
      recordId: row.id,
      status: row.status,
      measuredQuantity,
      totalWeightGrams: row.totalWeightGrams ?? legacyFallback?.totalWeightGrams ?? null,
      tareWeightGrams: row.tareWeightGrams ?? legacyFallback?.tareWeightGrams ?? null,
      netWeightGrams: row.netWeightGrams ?? legacyFallback?.netWeightGrams ?? null,
      unitWeightGrams: row.unitWeightGrams ?? legacyFallback?.unitWeightGrams ?? null,
      weightSource: row.weightSource === "SCALE" || row.weightSource === "FALLBACK"
        ? row.weightSource
        : legacyFallback
          ? "FALLBACK"
          : null,
    });
  }
  for (const row of auditRows) {
    if (!row.evidenceUrl || !row.capturedAt) continue;
    const existing = byBin.get(row.binId);
    if (existing && existing.capturedAt >= row.capturedAt.getTime()) continue;
    byBin.set(row.binId, {
      imageUrl: row.evidenceUrl,
      capturedAt: row.capturedAt.getTime(),
      source: "INVENTORY_AUDIT",
      recordId: row.id,
      status: row.status,
      confidencePercent:
        row.countConfidence === null ? null : confidencePercent(row.countConfidence),
    });
  }
  return byBin;
}

export async function getWarehouseOverview(movementLimit?: number): Promise<WarehouseOverview> {
  const [bins, inventoryRows, movements, putawayImages, latestBinSnapshots, latestAudit] = await Promise.all([
    prisma.bin.findMany({
      orderBy: { code: "asc" },
      include: { inventory: { include: { part: true }, orderBy: { part: { sku: "asc" } } } },
    }),
    prisma.inventory.findMany({
      include: { part: true, bin: true },
      orderBy: [{ part: { sku: "asc" } }, { bin: { code: "asc" } }],
    }),
    prisma.movement.findMany({
      orderBy: { createdAt: "desc" },
      take: clampMovementLimit(movementLimit),
      include: { part: true, sourceBin: true, destinationBin: true },
    }),
    loadPutawayImages(),
    loadLatestBinSnapshots(),
    prisma.inventoryAuditRun.findFirst({
      orderBy: { createdAt: "desc" },
      include: AUDIT_RUN_WITH_BINS,
    }),
  ]);

  const binViews: BinView[] = bins.map((bin) => {
    const simulationImageUrl = simulationSnapshotOverride(bin.code);
    const contents = bin.inventory
      // A zero row is bookkeeping left behind by a retrieval, not stock. It
      // must not draw a part into a bin that is physically empty.
      .filter((row) => row.quantity > 0)
      .map((row) => ({
        partId: row.partId,
        sku: row.part.sku,
        canonicalName: row.part.canonicalName,
        quantity: row.quantity,
        catalogImageUrl: row.part.imageUrl,
        imageUrl: simulationImageUrl ?? putawayImages.get(`${row.partId}:${bin.id}`) ?? null,
      }));

    const realSnapshot = latestBinSnapshots.get(bin.id) ?? null;
    const latestSnapshot = simulationImageUrl
      ? {
          imageUrl: simulationImageUrl,
          capturedAt: realSnapshot?.capturedAt ?? Date.now(),
          source: "INVENTORY_AUDIT" as const,
          recordId: realSnapshot?.recordId ?? "simulation-baseline",
          status: "VERIFIED",
          confidencePercent: 100,
        }
      : realSnapshot;

    return {
      binId: bin.id,
      code: bin.code,
      // The Bin row's own status, verbatim. Never derived from `contents`.
      status: bin.status as BinStatus,
      capacity: bin.capacity,
      contents,
      totalQuantity: contents.reduce((sum, item) => sum + item.quantity, 0),
      latestSnapshot,
    };
  });

  // Grouped by part so one SKU spread over several bins reads as one line
  // ("Qty 3 — B1-02 (1), B2-01 (2)") rather than as several unrelated rows.
  const byPart = new Map<string, InventoryRowView>();
  for (const row of inventoryRows) {
    if (row.quantity <= 0) continue;
    const existing = byPart.get(row.partId);
    const checkedOut = row.bin.status === "CHECKED_OUT";
    if (existing) {
      if (checkedOut) existing.checkedOutQuantity = (existing.checkedOutQuantity ?? 0) + row.quantity;
      else if (row.bin.status === "OCCUPIED") existing.totalQuantity += row.quantity;
      existing.locations.push({
        binCode: row.bin.code,
        binStatus: row.bin.status as BinStatus,
        quantity: row.quantity,
      });
      continue;
    }
    byPart.set(row.partId, {
      partId: row.partId,
      sku: row.part.sku,
      canonicalName: row.part.canonicalName,
      category: row.part.category,
      totalQuantity: row.bin.status === "OCCUPIED" ? row.quantity : 0,
      checkedOutQuantity: checkedOut ? row.quantity : 0,
      locations: [{
        binCode: row.bin.code,
        binStatus: row.bin.status as BinStatus,
        quantity: row.quantity,
      }],
    });
  }
  const inventory = [...byPart.values()];

  const movementViews: MovementRowView[] = movements.map((movement) => ({
    id: movement.id,
    type: movement.type as MovementType,
    status: movement.status as MovementStatus,
    sku: movement.part.sku,
    canonicalName: movement.part.canonicalName,
    quantity: movement.quantity,
    // A bin if there is one, otherwise the free-text station (INTAKE/OUTPUT).
    source: movement.sourceBin?.code ?? movement.sourceLocation,
    destination: movement.destinationBin?.code ?? movement.destinationLocation,
    createdAt: movement.createdAt.getTime(),
    completedAt: movement.completedAt?.getTime() ?? null,
  }));

  const auditView: InventoryAuditView | null = latestAudit
    ? toInventoryAuditView(latestAudit)
    : null;

  return {
    generatedAt: Date.now(),
    bins: binViews,
    inventory,
    movements: movementViews,
    latestAudit: auditView,
    totals: {
      units: inventory.reduce((sum, row) => sum + row.totalQuantity, 0),
      distinctParts: inventory.length,
      binsAvailable: binViews.filter((bin) => bin.status === "AVAILABLE").length,
      binsOccupied: binViews.filter((bin) => bin.status === "OCCUPIED").length,
    },
  };
}
