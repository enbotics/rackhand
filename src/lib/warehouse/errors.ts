/**
 * Warehouse-specific failures, each mapped to the HTTP status a route
 * handler should return. Callers get a meaningful code instead of a generic
 * failure, matching how /api/measure keeps its own reasons distinct.
 */

export const WAREHOUSE_ERROR_STATUS = {
  validation_failed: 422,
  invalid_quantity: 422,
  part_not_found: 404,
  bin_not_found: 404,
  inventory_not_found: 404,
  movement_not_found: 404,
  duplicate_sku: 409,
  duplicate_bin_code: 409,
  bin_unavailable: 409,
  bin_capacity_exceeded: 409,
  inventory_conflict: 409,
  insufficient_inventory: 409,
  invalid_status_transition: 409,
  internal_error: 500,
} as const;

export type WarehouseErrorCode = keyof typeof WAREHOUSE_ERROR_STATUS;

export class WarehouseError extends Error {
  readonly code: WarehouseErrorCode;
  /** Field-level detail for validation_failed; empty for the rest. */
  readonly issues: string[];

  constructor(code: WarehouseErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "WarehouseError";
    this.code = code;
    this.issues = issues;
  }

  get status(): number {
    return WAREHOUSE_ERROR_STATUS[this.code];
  }
}

export function isWarehouseError(value: unknown): value is WarehouseError {
  return value instanceof WarehouseError;
}

/**
 * Prisma's unique-constraint violation. Duck-typed rather than imported so
 * this stays independent of where the generated client happens to export its
 * error classes.
 */
export function isUniqueConstraintError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "P2002"
  );
}
