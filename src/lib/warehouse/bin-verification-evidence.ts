import { prisma } from "./db";

const TRUSTED_AUDIT_STATUSES = new Set([
  "VERIFIED",
  "AUTO_RECONCILED",
  "CONFIRMED",
]);

export type BinVerificationState =
  | "TRUSTED"
  | "NEVER_VERIFIED"
  | "CHANGED_AFTER_VERIFICATION"
  | "LATEST_AUDIT_UNRESOLVED";

export interface BinVerificationEvidence {
  binCode: string;
  state: BinVerificationState;
  trusted: boolean;
  lastVerifiedAt: string | null;
  lastInventoryChangeAt: string | null;
  latestAuditStatus: string | null;
  reason: string;
}

interface EvidenceInput {
  binCode: string;
  latestAudit: {
    status: string;
    createdAt: Date;
    capturedAt: Date | null;
    completedAt: Date | null;
  } | null;
  latestDestinationMovement: {
    type: string;
    createdAt: Date;
    completedAt: Date | null;
    verificationCapturedAt: Date | null;
    verificationImageUrl: string | null;
  } | null;
  latestSourceMovement: {
    createdAt: Date;
    completedAt: Date | null;
  } | null;
}

function latest(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function movementAt(movement: { createdAt: Date; completedAt: Date | null } | null): Date | null {
  return movement ? movement.completedAt ?? movement.createdAt : null;
}

/**
 * A verification remains useful until a later completed warehouse event can
 * have changed the bin. Time passing by itself never invalidates evidence.
 *
 * A verified PUTAWAY is effective at movement completion: its camera frame is
 * captured immediately before motion, while the inventory/status commit is
 * the last step of that same operation. Comparing only the earlier capture
 * timestamp to that commit would incorrectly mark every putaway stale.
 */
export function classifyBinVerificationEvidence(input: EvidenceInput): BinVerificationEvidence {
  const auditObservedAt = input.latestAudit
    ? input.latestAudit.capturedAt ?? input.latestAudit.completedAt ?? input.latestAudit.createdAt
    : null;
  const trustedAuditAt =
    input.latestAudit && TRUSTED_AUDIT_STATUSES.has(input.latestAudit.status)
      ? input.latestAudit.completedAt ?? input.latestAudit.capturedAt
      : null;
  const destinationAt = movementAt(input.latestDestinationMovement);
  const sourceAt = movementAt(input.latestSourceMovement);
  const lastInventoryChangeAt = latest(destinationAt, sourceAt);
  const verifiedPutawayAt =
    input.latestDestinationMovement?.type === "PUTAWAY" &&
    input.latestDestinationMovement.verificationCapturedAt &&
    input.latestDestinationMovement.verificationImageUrl
      ? destinationAt
      : null;
  const lastVerifiedAt = latest(trustedAuditAt, verifiedPutawayAt);
  const unresolvedLatestAudit = Boolean(
    input.latestAudit &&
      !TRUSTED_AUDIT_STATUSES.has(input.latestAudit.status) &&
      auditObservedAt &&
      (!lastVerifiedAt || auditObservedAt > lastVerifiedAt),
  );

  let state: BinVerificationState;
  let reason: string;
  if (unresolvedLatestAudit) {
    state = "LATEST_AUDIT_UNRESOLVED";
    reason = `latest audit is ${input.latestAudit!.status}`;
  } else if (!lastVerifiedAt) {
    state = "NEVER_VERIFIED";
    reason = "no accepted audit or verified putaway exists";
  } else if (lastInventoryChangeAt && lastInventoryChangeAt > lastVerifiedAt) {
    state = "CHANGED_AFTER_VERIFICATION";
    reason = "inventory-changing activity occurred after the latest trusted verification";
  } else {
    state = "TRUSTED";
    reason = "latest trusted verification is not older than any inventory-changing activity";
  }

  return {
    binCode: input.binCode,
    state,
    trusted: state === "TRUSTED",
    lastVerifiedAt: lastVerifiedAt?.toISOString() ?? null,
    lastInventoryChangeAt: lastInventoryChangeAt?.toISOString() ?? null,
    latestAuditStatus: input.latestAudit?.status ?? null,
    reason,
  };
}

/** Read persisted evidence for exact bins. No camera, movement or write occurs. */
export async function getBinVerificationEvidence(
  binCodes: readonly string[],
): Promise<Map<string, BinVerificationEvidence>> {
  const normalized = [...new Set(binCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) return new Map();

  const bins = await prisma.bin.findMany({
    where: { code: { in: normalized } },
    select: {
      code: true,
      binAudits: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          createdAt: true,
          capturedAt: true,
          completedAt: true,
        },
      },
      movementsToThisBin: {
        where: { status: "COMPLETED" },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          type: true,
          createdAt: true,
          completedAt: true,
          verificationCapturedAt: true,
          verificationImageUrl: true,
        },
      },
      movementsFromThisBin: {
        where: { status: "COMPLETED" },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { createdAt: true, completedAt: true },
      },
    },
  });

  return new Map(
    bins.map((bin) => {
      const evidence = classifyBinVerificationEvidence({
        binCode: bin.code,
        latestAudit: bin.binAudits[0] ?? null,
        latestDestinationMovement: bin.movementsToThisBin[0] ?? null,
        latestSourceMovement: bin.movementsFromThisBin[0] ?? null,
      });
      return [bin.code, evidence];
    }),
  );
}
