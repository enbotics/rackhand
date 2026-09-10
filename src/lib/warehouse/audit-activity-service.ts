import { compareBinsInShelfOrder } from "./bin-layout";
import { prisma } from "./db";

const OBSERVATION_WINDOW_HOURS = 24;
const AUDIT_COOLDOWN_HOURS = 6;

export interface DailyBinActivity {
  binCode: string;
  binStatus: string;
  sku: string | null;
  recordedQuantity: number;
  movements: number;
  retrievals: number;
  putaways: number;
  adjustments: number;
  lastMovementAt: string | null;
  lastAuditAt: string | null;
  lastAuditStatus: string | null;
  priorityScore: number;
  eligibleNow: boolean;
  reasons: string[];
}

export interface DailyAuditObservation {
  observedFrom: string;
  observedTo: string;
  recommendedBinCode: string | null;
  candidates: DailyBinActivity[];
}

interface MovementActivity {
  movements: Set<string>;
  retrievals: number;
  putaways: number;
  adjustments: number;
  lastMovementAt: Date | null;
}

function activityFor(map: Map<string, MovementActivity>, binId: string): MovementActivity {
  const existing = map.get(binId);
  if (existing) return existing;
  const created: MovementActivity = {
    movements: new Set(),
    retrievals: 0,
    putaways: 0,
    adjustments: 0,
    lastMovementAt: null,
  };
  map.set(binId, created);
  return created;
}

function hoursSince(date: Date, now: Date): number {
  return Math.max(0, (now.getTime() - date.getTime()) / 3_600_000);
}

/**
 * Produces a deterministic, read-only observation of the rolling day's bin
 * activity. It never schedules or starts an audit; the Warehouse Agent uses
 * these facts when it is already running and remains the decision-maker.
 */
export async function observeDailyBinActivity(now: Date = new Date()): Promise<DailyAuditObservation> {
  const observedFrom = new Date(now.getTime() - OBSERVATION_WINDOW_HOURS * 3_600_000);
  const [bins, movements] = await Promise.all([
    prisma.bin.findMany({
      where: { status: { in: ["AVAILABLE", "OCCUPIED"] } },
      include: {
        inventory: { where: { quantity: { gt: 0 } }, include: { part: true } },
        binAudits: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.movement.findMany({
      where: {
        status: "COMPLETED",
        completedAt: { gte: observedFrom, lte: now },
        OR: [{ sourceBinId: { not: null } }, { destinationBinId: { not: null } }],
      },
      select: {
        id: true,
        type: true,
        sourceBinId: true,
        destinationBinId: true,
        completedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const byBin = new Map<string, MovementActivity>();
  for (const movement of movements) {
    const touched = new Set(
      [movement.sourceBinId, movement.destinationBinId].filter(
        (value): value is string => value !== null,
      ),
    );
    for (const binId of touched) {
      const activity = activityFor(byBin, binId);
      activity.movements.add(movement.id);
      const movedAt = movement.completedAt ?? movement.createdAt;
      if (!activity.lastMovementAt || movedAt > activity.lastMovementAt) {
        activity.lastMovementAt = movedAt;
      }
      if (movement.type === "RETRIEVAL" && movement.sourceBinId === binId) {
        activity.retrievals += 1;
      }
      if (movement.type === "PUTAWAY" && movement.destinationBinId === binId) {
        activity.putaways += 1;
      }
      if (movement.type === "ADJUSTMENT" && movement.destinationBinId === binId) {
        activity.adjustments += 1;
      }
    }
  }

  const mostRetrievals = Math.max(
    0,
    ...Array.from(byBin.values(), (activity) => activity.retrievals),
  );
  const candidates = bins.map((bin): DailyBinActivity => {
    const activity = byBin.get(bin.id);
    const movementCount = activity?.movements.size ?? 0;
    const lastAudit = bin.binAudits[0] ?? null;
    const lastAuditAgeHours = lastAudit ? hoursSince(lastAudit.createdAt, now) : null;
    const inCooldown = lastAuditAgeHours !== null && lastAuditAgeHours < AUDIT_COOLDOWN_HOURS;
    const priorIssue =
      lastAudit?.status === "REVIEW_REQUIRED" || lastAudit?.status === "FAILED";
    const priorReconciliation = lastAudit?.status === "AUTO_RECONCILED";
    const highActivity = movementCount >= 5;
    const mostRetrieved =
      (activity?.retrievals ?? 0) > 0 && activity?.retrievals === mostRetrievals;
    const recentlyAdjusted = (activity?.adjustments ?? 0) > 0;
    const reasons: string[] = [];

    const activityPoints = Math.min(60, movementCount * 12);
    const freshnessPoints =
      lastAuditAgeHours === null ? 20 : lastAuditAgeHours >= 168 ? 20 : lastAuditAgeHours >= 24 ? 10 : 0;
    const historyPoints = priorIssue ? 20 : priorReconciliation ? 15 : 0;
    const adjustmentPoints = Math.min(15, (activity?.adjustments ?? 0) * 15);
    const priorityScore = Math.min(
      100,
      activityPoints + freshnessPoints + historyPoints + adjustmentPoints,
    );

    if (movementCount > 0) reasons.push(`${movementCount} completed movement${movementCount === 1 ? "" : "s"} in the last 24 hours`);
    if (activity?.retrievals) reasons.push(`${activity.retrievals} retrieval${activity.retrievals === 1 ? "" : "s"}`);
    if (activity?.putaways) reasons.push(`${activity.putaways} putaway${activity.putaways === 1 ? "" : "s"}`);
    if (activity?.adjustments) reasons.push(`${activity.adjustments} operator adjustment${activity.adjustments === 1 ? "" : "s"}`);
    if (!lastAudit) reasons.push("no prior physical audit");
    else if (priorIssue) reasons.push(`latest audit requires attention (${lastAudit.status})`);
    else if (priorReconciliation) reasons.push("latest audit found and reconciled a discrepancy");
    if (inCooldown) reasons.push("inside the six-hour audit cooldown");
    if (highActivity) reasons.push("high activity threshold reached");
    if (mostRetrieved) reasons.push("most retrieved shelf bin in the observation window");

    const inventory = bin.inventory[0] ?? null;
    return {
      binCode: bin.code,
      binStatus: bin.status,
      sku: inventory?.part.sku ?? null,
      recordedQuantity: bin.inventory.reduce((sum, row) => sum + row.quantity, 0),
      movements: movementCount,
      retrievals: activity?.retrievals ?? 0,
      putaways: activity?.putaways ?? 0,
      adjustments: activity?.adjustments ?? 0,
      lastMovementAt: activity?.lastMovementAt?.toISOString() ?? null,
      lastAuditAt: lastAudit?.createdAt.toISOString() ?? null,
      lastAuditStatus: lastAudit?.status ?? null,
      priorityScore,
      eligibleNow:
        !inCooldown &&
        (highActivity || mostRetrieved || recentlyAdjusted || priorIssue),
      reasons,
    };
  });

  candidates.sort((left, right) => {
    if (left.eligibleNow !== right.eligibleNow) return left.eligibleNow ? -1 : 1;
    if (left.priorityScore !== right.priorityScore) return right.priorityScore - left.priorityScore;
    return compareBinsInShelfOrder({ code: left.binCode }, { code: right.binCode });
  });

  return {
    observedFrom: observedFrom.toISOString(),
    observedTo: now.toISOString(),
    recommendedBinCode: candidates.find((candidate) => candidate.eligibleNow)?.binCode ?? null,
    candidates,
  };
}
