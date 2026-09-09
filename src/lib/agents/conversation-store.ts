/**
 * Server-owned conversation memory for the Warehouse Agent.
 *
 * WHY THIS EXISTS. Every POST to /api/agent used to build a brand new Agent and
 * hand it only the current message, so the orchestrator was structurally unable
 * to remember anything. "I'd like to retrieve B1-01" followed by "I'd like to
 * put it away" arrived as two unrelated first messages: with no idea what "it"
 * was, the model called execute_putaway with no binCode and the warehouse layer
 * fell back to whatever happened to be checked out globally — the wrong bin,
 * from the operator's point of view.
 *
 * WHO OWNS THE HISTORY. The server, entirely. The browser may send an opaque
 * session identifier and nothing else about the conversation: no messages, no
 * tool-call blocks, no "the tool succeeded" claims. That boundary is the whole
 * point of the design documented in /api/agent/route.ts — a client that could
 * restate history could fabricate a tool result and talk the agent into acting
 * on a movement that never happened. A session id is a lookup key into state
 * this process wrote itself; it is not content.
 *
 * WHAT IS STORED. A Strands `Snapshot` per session, JSON round-tripped so it is
 * inert data rather than a live object graph holding a model client or AWS
 * credentials — the same treatment the HITL approval snapshot already gets.
 * `systemPrompt` is deliberately EXCLUDED from the capture: the safety policy
 * must always come from the current server build, never from a snapshot taken
 * before it was edited. `interrupts` are excluded for the same reason the store
 * only ever saves completed turns — a parked interrupt belongs to the approval
 * store, which owns resuming it.
 *
 * PROCESS-LOCAL, exactly like the gantry singleton in lib/gantry/factory.ts and
 * the pending-approval map: cached on globalThis so Next.js hot reloads and
 * separate route modules share one map instead of each getting its own. It is
 * not shared across processes, does not survive a restart, and deliberately
 * involves no Redis, no external state and no database table. Losing it costs
 * chat continuity and nothing else — warehouse truth lives in Postgres.
 *
 * Two requests racing on one session id are last-write-wins. One operator with
 * one tab does not race, and the alternative — locking a conversation — would
 * buy nothing that matters here.
 */
import type { Snapshot } from "@strands-agents/sdk";
import { AgentError } from "./errors";

/**
 * How long an untouched conversation stays resumable.
 *
 * Long enough to survive a coffee break mid-task, short enough that a demo
 * server left running overnight does not keep yesterday's context alive and
 * quietly answer this morning's "put it away" from it.
 */
export const CONVERSATION_IDLE_TTL_MS = 30 * 60 * 1000;

/** Bounded so a long-running dev server cannot grow the map without limit. */
const MAX_CONVERSATIONS = 100;

/**
 * An opaque client-generated handle. Constrained so it can only ever be a map
 * key: no path characters, no length worth abusing, and nothing that could be
 * mistaken for content if it were ever logged.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

interface ConversationEntry {
  snapshot: Snapshot;
  /** Last time this conversation was read or written, for idle eviction. */
  lastUsedAt: number;
}

const globalForConversations = globalThis as unknown as {
  warehouseConversations?: Map<string, ConversationEntry>;
};
const conversations = (globalForConversations.warehouseConversations ??= new Map());

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of conversations) {
    if (now - entry.lastUsedAt >= CONVERSATION_IDLE_TTL_MS) conversations.delete(id);
  }
  // Oldest-first eviction if something is leaking; Map preserves insertion order
  // and every touch re-inserts, so the head really is the least recently used.
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
}

/**
 * Validates the optional session id a browser may attach to a turn.
 *
 * Absent is legitimate and simply means "no memory for this turn" — the smoke
 * test script and the trusted server-side observation path both run that way.
 * Present-but-malformed is an error rather than a silent downgrade, so a client
 * bug shows up as a failed request instead of an agent that mysteriously
 * forgets.
 */
export function validateAgentSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new AgentError("agent_invalid_request", [
      "sessionId must be 8-128 characters of letters, digits, hyphen or underscore",
    ]);
  }
  return value;
}

/** The stored conversation for this session, or null when there is none yet. */
export function loadConversation(sessionId: string | null): Snapshot | null {
  if (!sessionId) return null;
  sweep();

  const entry = conversations.get(sessionId);
  if (!entry) return null;

  // Touch: re-insert so the Map's order stays least-recently-used first.
  conversations.delete(sessionId);
  entry.lastUsedAt = Date.now();
  conversations.set(sessionId, entry);
  return entry.snapshot;
}

/** Replaces this session's stored conversation with the turn that just ended. */
export function saveConversation(sessionId: string | null, snapshot: Snapshot): void {
  if (!sessionId) return;

  conversations.delete(sessionId);
  conversations.set(sessionId, { snapshot, lastUsedAt: Date.now() });
  sweep();
}

/** Forgets one conversation. The warehouse database is untouched. */
export function clearConversation(sessionId: string): void {
  conversations.delete(sessionId);
}

/** Test/dev helper: forget every conversation. */
export function clearAllConversations(): void {
  conversations.clear();
}

export function conversationCount(): number {
  return conversations.size;
}
