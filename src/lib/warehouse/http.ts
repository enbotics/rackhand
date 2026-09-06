/**
 * Shared request/response plumbing for the warehouse route handlers.
 *
 * The error envelope matches /api/measure's — `{ error: { code, message } }`
 * — so the whole app reports failures the same way, with warehouse codes
 * (part_not_found, duplicate_sku, insufficient_inventory, ...) carrying their
 * own HTTP status instead of collapsing into a generic 500.
 */
import { NextResponse } from "next/server";
import { WarehouseError, isWarehouseError } from "./errors";

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new WarehouseError("validation_failed", "Body is not parseable JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WarehouseError("validation_failed", "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function warehouseErrorResponse(err: unknown): NextResponse {
  if (isWarehouseError(err)) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.issues.length > 0 ? { issues: err.issues } : {}),
        },
      },
      { status: err.status },
    );
  }

  console.error("[warehouse] unexpected failure:", err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected warehouse failure." } },
    { status: 500 },
  );
}

/** Reads a trimmed query parameter, or null when absent/blank. */
export function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Reads a positive integer query parameter, or undefined when absent/invalid. */
export function intQueryParam(request: Request, name: string): number | undefined {
  const raw = queryParam(request, name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
