"use client";

/** One opaque workflow/conversation owner per browser tab. */
const WAREHOUSE_SESSION_STORAGE_KEY = "ugreen:agent-session-id";
let memorySessionId: string | null = null;

function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function warehouseBrowserSessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(WAREHOUSE_SESSION_STORAGE_KEY);
    if (stored) return stored;
    const created = newSessionId();
    window.sessionStorage.setItem(WAREHOUSE_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    memorySessionId ??= newSessionId();
    return memorySessionId;
  }
}
