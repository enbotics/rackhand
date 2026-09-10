/** Shared browser/API contract for isolating operator camera workflows. */
export const WAREHOUSE_SESSION_HEADER = "x-warehouse-session-id";
export const WAREHOUSE_SESSION_QUERY = "sessionId";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function normalizeWarehouseSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized : null;
}

/** EventSource uses the query value; normal fetches use the header. */
export function warehouseSessionIdFromRequest(request: Request): string | null {
  const header = normalizeWarehouseSessionId(
    request.headers.get(WAREHOUSE_SESSION_HEADER),
  );
  if (header) return header;
  return normalizeWarehouseSessionId(
    new URL(request.url).searchParams.get(WAREHOUSE_SESSION_QUERY),
  );
}

export function requireWarehouseSessionId(request: Request): string {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) throw new Error("warehouse_session_required");
  return sessionId;
}
