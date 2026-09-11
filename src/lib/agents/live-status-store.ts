/**
 * Live "which tool is running right now" status for one in-flight agent turn.
 *
 * WHY THIS EXISTS. /api/agent is one blocking request: the browser gets
 * nothing back until the whole turn — possibly several chained tool calls —
 * finishes. Before this, the busy indicator GUESSED what was probably
 * happening from a hardcoded list of trigger phrases matched against the
 * operator's own message, client-side, before the server had done anything.
 * That guess had no connection to reality and reliably missed any phrasing
 * not on its list. This store instead records the REAL tool name the instant
 * the SDK's own BeforeToolCallEvent fires (see warehouse-agent.ts), so a
 * polling browser can show a fact instead of a guess.
 *
 * PROCESS-LOCAL AND EPHEMERAL, same caveat as approval-store's in-process
 * map: this is presentation only, never warehouse truth, and is expected to
 * be briefly stale or empty across a redeploy/restart — nothing here decides
 * what physically happens, it only reports what already is happening.
 *
 * KEYED BY THE BROWSER'S OWN SESSION ID (warehouseBrowserSessionId, the same
 * id already used for conversation continuity and camera/materials-plan
 * polling), not a fresh per-request id: the id has to be something the
 * browser already holds BEFORE the request completes, since there is no
 * response yet to hand one back in.
 */

interface LiveToolStatus {
  toolName: string;
  updatedAt: number;
}

/** Long enough to outlive a slow tool call, short enough that a crashed request cannot show a phantom label forever. */
const STATUS_TTL_MS = 2 * 60 * 1000;

/** Bounded so an abandoned session cannot grow the map without limit. */
const MAX_ENTRIES = 200;

const globalForLiveStatus = globalThis as unknown as {
  warehouseLiveToolStatus?: Map<string, LiveToolStatus>;
};
const statusBySession = (globalForLiveStatus.warehouseLiveToolStatus ??= new Map());

function sweep(now = Date.now()): void {
  for (const [id, entry] of statusBySession) {
    if (now - entry.updatedAt > STATUS_TTL_MS) statusBySession.delete(id);
  }
  while (statusBySession.size > MAX_ENTRIES) {
    const oldest = statusBySession.keys().next().value;
    if (oldest === undefined) break;
    statusBySession.delete(oldest);
  }
}

/** Called from BeforeToolCallEvent — records the tool the agent is about to run. */
export function setLiveToolStatus(sessionId: string, toolName: string): void {
  sweep();
  statusBySession.set(sessionId, { toolName, updatedAt: Date.now() });
}

/** Called once the whole turn (invoke or resume) finishes, success or failure. */
export function clearLiveToolStatus(sessionId: string): void {
  statusBySession.delete(sessionId);
}

/** Read by the polling status route. Null once nothing is running or the entry expired. */
export function getLiveToolStatus(sessionId: string): { toolName: string } | null {
  const entry = statusBySession.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STATUS_TTL_MS) {
    statusBySession.delete(sessionId);
    return null;
  }
  return { toolName: entry.toolName };
}
