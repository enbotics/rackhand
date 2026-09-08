/**
 * Request/response plumbing for the gantry routes, using the same
 * `{ error: { code, message } }` envelope as /api/measure and the warehouse
 * routes. Kept local to the gantry so this subsystem stays independent of the
 * warehouse layer.
 */
import { NextResponse } from "next/server";
import { GantryError, isGantryError } from "./errors";

export async function parseGantryBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new GantryError("invalid_request", "Body is not parseable JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GantryError("invalid_request", "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function gantryErrorResponse(err: unknown): NextResponse {
  if (isGantryError(err)) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status },
    );
  }

  console.error("[gantry] unexpected failure:", err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected gantry failure." } },
    { status: 500 },
  );
}

/**
 * Guards the raw movement routes (Milestone 13 freeze).
 *
 * `/api/gantry/home`, `/api/gantry/putaway` and `/api/gantry/retrieve` command
 * the machine directly: they create no Movement, touch no inventory and ask
 * for no approval. Nothing in the application calls them — the dashboard uses
 * only the read-only `/status` and `/operations` — and every warehouse
 * operation goes through PutawayService or RetrievalService instead.
 *
 * They stay for bench-testing a controller by hand, which is what Milestones
 * 14-15 will need. Refusing them outside development means attaching real
 * hardware cannot also expose an unapproved, unrecorded way to move it.
 *
 * The read-only routes are deliberately NOT guarded.
 */
export function assertGantryDevRoute(): void {
  if (process.env.NODE_ENV === "production") {
    throw new GantryError(
      "gantry_dev_only",
      "Direct gantry movement endpoints are development-only. Use the Warehouse Agent, which validates, records and approves client operations.",
    );
  }
}
