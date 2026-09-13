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
  action:
    | "PUTAWAY"
    | "RETRIEVAL"
    | "INVENTORY_AUDIT"
    | "MATERIALS_FULFILLMENT";
  sku: string | null;
  canonicalName: string | null;
  source: string | null;
  destination: string | null;
  quantity: number | null;
  scope?: "COUNTED_UNITS" | "ENTIRE_BIN" | "AUDIT_BINS" | "MATERIALS_PLAN";
  capacity?: { before: number; after: number; limit: number } | null;
  /**
   * True only for the model's own follow-up offer to put a just-retrieved bin
   * back (see warehouse-prompt.ts's ONE narrow exception), never for a
   * putaway the operator asked for directly. The UI uses this to show a
   * short yes/no question instead of the full technical approval card —
   * Approve/Deny still mean exactly the same thing underneath.
   */
  autoSuggested?: boolean;
  /** Server-owned opt-in for the exact prompt's simulation-only demo. */
  browserScenario?: "CONTROL_MODULE";
  /**
   * Plain-text item descriptions still owed from the operator's original
   * multi-item fulfillment request ("I need screws and allen keys"), not yet
   * attempted — never including the item THIS approval itself concerns.
   * Carried forward, hop by hop, from one approval's summary to the next
   * (retrieval → its auto-suggested putaway → the next item's retrieval …)
   * so the server can force the whole list through deterministically instead
   * of trusting the model to remember and re-propose each one unprompted.
   * Absent or empty once nothing is left owed.
   */
  fulfillmentQueue?: string[];
  /**
   * How many items the operator's original multi-item request named in total
   * (this one plus everything ever queued). Set once, when the queue is first
   * seeded from remainingItems, and carried forward unchanged on every later
   * hop — so `fulfillmentTotal - fulfillmentQueue.length` always tells the
   * approval prompt which position in the list this item is, without needing
   * a separate "is this the first one" flag threaded through every call site.
   */
  fulfillmentTotal?: number;
  /**
   * Set only when creating THIS approval automatically retired an older,
   * still-undecided approval left open on the same session — see
   * settleStaleApprovalForSession. Always computed here from the retired
   * entry's own recorded summary, never supplied by the model, so the
   * operator-facing note this produces can only ever describe a real
   * cancelled approval.
   */
  supersededDestination?: string | null;
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

function sweepLocal(now = Date.now()): void {
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

/** Expire durable audit rows even when their original browser never returns. */
async function sweepExpiredApprovals(now = new Date()): Promise<void> {
  sweepLocal(now.getTime());
  await prisma.actionApproval.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED", resolvedAt: now },
  });
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
  await sweepExpiredApprovals();

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
      reason: audit.status === "EXPIRED" ? "approval_expired" : "approval_not_pending",
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

/**
 * Retires any OTHER pending approval already open for this session before a
 * new one is created for it — see parkForApproval in warehouse-agent.ts.
 *
 * WHY THIS EXISTS. A physical-tool approval pauses the turn that raised it,
 * but nothing stops the operator from typing a brand new message instead of
 * deciding that card. A fresh turn started that way has no way of knowing an
 * older offer is still sitting there, and can end up creating a SECOND live
 * approval for the same bin — a live multi-item test surfaced exactly this:
 * an ignored auto-suggested "put it back?" offer stayed pending in the
 * background while a freshly typed "put away now" opened its own approval
 * for the identical bin. Whichever one executed first genuinely moved it;
 * the other, decided afterward, correctly reported "nothing to put away" —
 * true in the moment, but read as flatly contradictory with no explanation.
 *
 * The fix enforces "at most one live approval per session" at the one point
 * it actually matters — right before a NEW one is created — rather than ever
 * blocking the composer. A session that never creates a second approval (the
 * overwhelming majority of turns: read-only questions, an unrelated request)
 * never touches this at all, so an operator is always free to ask something
 * else while a card waits. Only when their NEXT action also raises a fresh
 * physical-tool approval does the older, still-undecided one get retired.
 *
 * Safe to retire: an approval that never executed changed nothing, so
 * DENYING it here costs exactly what an explicit decline would have.
 */
export async function settleStaleApprovalForSession(
  sessionId: string | null,
): Promise<PendingApproval | null> {
  if (!sessionId) return null;
  for (const entry of pending.values()) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(entry.approvalId);
    // Guarded on status: if a genuine concurrent APPROVE/DENY already settled
    // this exact approval a moment ago, that real decision must never be
    // overwritten by this cleanup.
    const updated = await prisma.actionApproval.updateMany({
      where: { id: entry.approvalId, status: "PENDING" },
      data: { status: "DENIED", resolvedAt: new Date() },
    });
    if (updated.count === 0) continue;
    console.log(`[approval] superseded=${entry.approvalId} session=${sessionId}`);
    return entry;
  }
  return null;
}

/** Test helper: forget every pending snapshot without touching the audit trail. */
export function clearPendingApprovals(): void {
  pending.clear();
}

export function pendingApprovalCount(): number {
  return pending.size;
}
