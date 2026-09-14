/**
 * Machine-level input failures, in the same `{ error: { code, message } }`
 * envelope the rest of the app uses.
 *
 * Only *requests* throw. An operation that starts and then fails — a dropped
 * part, a movement timeout — is not an exception: it is a recorded outcome,
 * returned as a GantryOperation with status FAILED. See simulator.ts.
 */

export const GANTRY_ERROR_STATUS = {
  /** Public demo movements are restricted to the two approved simulation bins. */
  simulation_scope_violation: 403,
  /** Body was unparseable or structurally wrong. */
  invalid_request: 422,
  /** A source/destination that is not a legal location for this operation. */
  invalid_location: 422,
  /** The gantry is already executing something. */
  gantry_busy: 409,
  /** GANTRY_MODE asked for a controller this milestone does not implement. */
  gantry_mode_unsupported: 501,
  /**
   * A development-only endpoint was called outside development (Milestone 13).
   *
   * The raw movement routes drive the machine WITHOUT the warehouse services,
   * so they change nothing in the database and pass through no approval. That
   * is exactly what makes them useful for bench-testing a controller, and
   * exactly why they must not be reachable once a real gantry is attached: a
   * part moved this way leaves inventory silently wrong.
   */
  gantry_dev_only: 403,
} as const;

export type GantryErrorCode = keyof typeof GANTRY_ERROR_STATUS;

export class GantryError extends Error {
  readonly code: GantryErrorCode;

  constructor(code: GantryErrorCode, message: string) {
    super(message);
    this.name = "GantryError";
    this.code = code;
  }

  get status(): number {
    return GANTRY_ERROR_STATUS[this.code];
  }
}

export function isGantryError(value: unknown): value is GantryError {
  return value instanceof GantryError;
}
