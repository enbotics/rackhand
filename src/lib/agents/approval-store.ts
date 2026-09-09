/**
 * Pending action approvals (Milestone 9).
 *
 * TWO STORES, on purpose:
 *
 *  - The Strands interrupt snapshot lives in a bounded in-process map. It is
 *    runtime execution state, not warehouse truth. It must NOT survive a
 *    restart as something resumable: a snapshot that outlives the process it
 *    was taken in would let a stale plan execute against a warehouse that has
 *    moved on.
 *  - The DECISION is persisted to `ActionApproval` in the authoritative
 *    Supabase-backed database. Who approved
 *    what, when, and what it was approved to do is auditable warehouse
 *    history, and outlives everything.
 *
 * Approval ids are `randomUUID`, not sequential: an approval id IS the
 * authorization to execute a physical action, so it must not be guessable.
 *
 * Neither store holds model reasoning, prompts or credentials. The bounded,
 * in-process snapshot entry retains the scan photo only until an approval is
 * settled or expires; the persisted ActionApproval audit row never stores it.
 */
import { randomUUID } from "node:crypto";
import type { Snapshot } from "@strands-agents/sdk";
import { prisma } from "@/lib/warehouse/db";
import type { ScanResult } from "@/lib/warehouse/scan-types";

/** Short: an approval card describes a world that is still changing under it. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Bounded so a forgotten approval cannot grow the process without limit. */
const MAX_PENDING = 50;

export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
export type ApprovalDecision = "APPROVE" | "DENY";

/** What the browser is allowed to see. No reasoning, no raw model output. */
export interface ApprovalSummary {
  action: "PUTAWAY" | "RETRIEVAL" | "INVENTORY_AUDIT";
  sku: string | null;
  canonicalName: string | null;
  source: string | null;
  destination: string | null;
  quantity: number | null;
  scope?: "COUNTED_UNITS" | "ENTIRE_BIN" | "AUDIT_BINS";
  capacity?: { before: number; after: number; limit: number } | null;
}

export interface PendingApprovalView {
  approvalId: string;
  interruptId: string;
  action: string;
  summary: ApprovalSummary;
  expiresAt: string;
}

interface PendingApproval {
  approvalId: string;
  interruptId: string;
  toolName: string;
  /** The exact arguments the approval is bound to. Never re-supplied by the client. */
  toolInput: unknown;
  summary: ApprovalSummary;
  snapshot: Snapshot;
  /** Reused on resume, so approving twice cannot execute the operation twice. */
  requestId: string;
  scanResult: ScanResult | null;
  scanImageDataUrl: string | null;
  /** The operator's confirmed identity decision, restored on resume. */
  catalogResolutionId: string | null;
  /**
   * The observability trace this approval belongs to (Milestone 12). Restored
   * on resume so the pause and the decision are one timeline — clicking
   * APPROVE continues a story rather than starting a new one.
   */
  traceId: string | null;
  /**
   * The chat session this pause belongs to, when the request had one.
   *
   * Held here rather than round-tripped through the browser for exactly the
   * reason the tool arguments are: the approve/deny call carries an id and a
   * decision and nothing else, so a client cannot redirect a finished action's
   * memory into a different conversation. Never persisted to ActionApproval —
   * it is process-local chat state, not auditable warehouse history.
   */
  sessionId: string | null;
  expiresAt: number;
}

const globalForApprovals = globalThis as unknown as {
  warehousePendingApprovals?: Map<string, PendingApproval>;
};
const pending = (globalForApprovals.warehousePendingApprovals ??= new Map());

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  // Oldest-first eviction if something is leaking; Map preserves insertion order.
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export async function createPendingApproval(input: {
  interruptId: string;
  toolName: string;
  toolInput: unknown;
  summary: ApprovalSummary;
  snapshot: Snapshot;
  requestId: string;
  scanResult: ScanResult | null;
  scanImageDataUrl: string | null;
  catalogResolutionId: string | null;
  traceId: string | null;
  sessionId: string | null;
}): Promise<PendingApprovalView> {
  sweep();

  const approvalId = `approval_${randomUUID()}`;
  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  pending.set(approvalId, { ...input, approvalId, expiresAt });

  await prisma.actionApproval.create({
    data: {
      id: approvalId,
      toolName: input.toolName,
      summary: JSON.stringify(input.summary),
      status: "PENDING",
      interruptId: input.interruptId,
      requestId: input.requestId,
      traceId: input.traceId,
      expiresAt: new Date(expiresAt),
    },
  });

  console.log(
    `[approval] created=${approvalId} tool=${input.toolName} action=${input.summary.action} status=PENDING`,
  );

  return {
    approvalId,
    interruptId: input.interruptId,
    action: input.toolName,
    summary: input.summary,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export type ApprovalLookup =
  | {
      ok: true;
      approval: PendingApproval;
      /** When the approval was raised, so the human-decision wait can be timed. */
      createdAt: Date;
    }
  | {
      ok: false;
      reason: "approval_not_found" | "approval_expired" | "approval_not_pending";
      status?: ApprovalStatus;
      /**
       * From the persisted audit row, so an expired or already-settled decision
       * can still be reported on the timeline it belongs to — the in-process
       * entry that held it is gone by then.
       */
      traceId?: string | null;
      /** When the approval was raised, for the human-decision duration. */
      createdAt?: Date;
    };

/**
 * Loads a pending approval, enforcing both gates: the persisted decision
 * status and the in-process TTL. A terminal decision never reopens — approving
 * something already denied would defeat the point of asking.
 */
export async function claimApproval(approvalId: string): Promise<ApprovalLookup> {
  const audit = await prisma.actionApproval.findUnique({ where: { id: approvalId } });
  if (!audit) return { ok: false, reason: "approval_not_found" };

  if (audit.status !== "PENDING") {
    return {
      ok: false,
      reason: "approval_not_pending",
      status: audit.status as ApprovalStatus,
      traceId: audit.traceId,
      createdAt: audit.createdAt,
    };
  }

  const entry = pending.get(approvalId);
  const expired = audit.expiresAt.getTime() <= Date.now() || !entry;
  if (expired) {
    await prisma.actionApproval.update({
      where: { id: approvalId },
      data: { status: "EXPIRED", resolvedAt: new Date() },
    });
    pending.delete(approvalId);
    console.log(`[approval] expired=${approvalId}`);
    return {
      ok: false,
      reason: "approval_expired",
      traceId: audit.traceId,
      createdAt: audit.createdAt,
    };
  }

  return { ok: true, approval: entry, createdAt: audit.createdAt };
}

/**
 * Records the decision and removes the resumable snapshot.
 *
 * Returns how long the approval sat waiting for a person, which is the one
 * number that demonstrates the system genuinely paused rather than merely
 * claiming to. It is not model latency and is never presented as such.
 */
export async function settleApproval(
  approvalId: string,
  status: Exclude<ApprovalStatus, "PENDING">,
): Promise<{ humanDecisionDurationMs: number | null }> {
  pending.delete(approvalId);
  const resolvedAt = new Date();
  const updated = await prisma.actionApproval.update({
    where: { id: approvalId },
    data: { status, resolvedAt },
  });
  console.log(`[approval] settled=${approvalId} status=${status}`);
  return { humanDecisionDurationMs: resolvedAt.getTime() - updated.createdAt.getTime() };
}

/** Test helper: forget every pending snapshot without touching the audit trail. */
export function clearPendingApprovals(): void {
  pending.clear();
}

export function pendingApprovalCount(): number {
  return pending.size;
}
