import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GantryOperation } from "@/lib/gantry/types";

const fixture = vi.hoisted(() => {
  const part = { id: "part-1", sku: "SENSOR", canonicalName: "Sensor modules" };
  const bin = { id: "bin-1", code: "B1-02", status: "OCCUPIED", capacity: 100 };
  const stock = { id: "stock-1", partId: part.id, binId: bin.id, quantity: 12 };
  const movements: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const movement = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
      movements.find((row) => where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey) ?? null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `movement-${movements.length + 1}`, ...data };
      movements.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = movements.find((item) => item.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = movements.find((item) => item.id === where.id);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const database = {
    movement,
    part: { findUnique: vi.fn(async () => part) },
    bin: {
      findUnique: vi.fn(async () => bin),
      findMany: vi.fn(async () => bin.status === "CHECKED_OUT"
        ? [{ ...bin, inventory: [{ ...stock, part }] }] : []),
      updateMany: vi.fn(async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        if (where.status !== bin.status) return { count: 0 };
        bin.status = data.status;
        return { count: 1 };
      }),
    },
    inventory: {
      findUnique: vi.fn(async () => ({ ...stock })),
      updateMany: vi.fn(async ({ where, data }: { where: { quantity: number }; data: { quantity: number } }) => {
        if (where.quantity !== stock.quantity) return { count: 0 };
        stock.quantity = data.quantity;
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: { quantity: number } }) => {
        stock.quantity = data.quantity;
        return stock;
      }),
      delete: vi.fn(async () => { stock.quantity = 0; return stock; }),
    },
  };
  return { part, bin, stock, movements, events, database, verify: vi.fn(), revert: vi.fn(),
    retrieve: vi.fn<() => Promise<Partial<GantryOperation>>>(async () => { events.push("retrieve"); return { status: "COMPLETED", operationId: "gantry-1" }; }),
    returnBin: vi.fn<() => Promise<Partial<GantryOperation>>>(async () => { events.push("return"); return { status: "COMPLETED", operationId: "gantry-2" }; }) };
});

vi.mock("@/lib/warehouse/db", () => ({ prisma: {
  ...fixture.database,
  $transaction: async (callback: (tx: typeof fixture.database) => unknown) => callback(fixture.database),
} }));
vi.mock("@/lib/warehouse/repository", () => ({
  getBinByCode: async () => fixture.bin,
  getPartBySku: async () => fixture.part,
  getPartById: async () => fixture.part,
  updateMovementStatus: async (id: string, status: string) => {
    Object.assign(fixture.movements.find((row) => row.id === id)!, { status });
  },
}));
vi.mock("@/lib/warehouse/inventory-service", () => ({
  getInventoryByBin: async () => [{ sku: fixture.part.sku, quantity: fixture.stock.quantity }],
  getInventoryForPart: async () => ({ totalQuantity: fixture.stock.quantity,
    locations: [{ binCode: fixture.bin.code, quantity: fixture.stock.quantity, binStatus: fixture.bin.status }] }),
}));
vi.mock("@/lib/gantry/factory", () => ({ getGantryController: () => ({
  retrieve: fixture.retrieve, returnBin: fixture.returnBin,
}) }));
vi.mock("@/lib/warehouse/putaway-verification", () => ({ requirePutawayVerification: fixture.verify }));
vi.mock("@/lib/warehouse/putaway-recovery-service", () => ({ recoverAbandonedPutaways: async () => ({ recoveredMovementIds: [] }) }));
vi.mock("@/lib/warehouse/simulation-revert", () => ({ scheduleSimulationRevert: fixture.revert }));

import { executeRetrieval } from "@/lib/warehouse/retrieval-service";
import { returnCheckedOutBin } from "@/lib/warehouse/putaway-service";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.movements.length = 0;
  fixture.events.length = 0;
  fixture.bin.status = "OCCUPIED";
  fixture.stock.quantity = 12;
  fixture.verify.mockImplementation(async (id: string) => {
    fixture.events.push("verify");
    const movement = fixture.movements.find((row) => row.id === id)!;
    expect(movement.status).toBe(movement.type === "RETRIEVAL" ? "AWAITING_VERIFICATION" : "VALIDATED");
    return { imageUrl: "/checked.jpg", capturedAt: new Date(), quantity: fixture.stock.quantity,
      simulated: true, inventoryUpdateApproved: true };
  });
});

describe("user-requested bin checkout and return", () => {
  it("preserves reservations and idempotency after an uncertain physical retrieval", async () => {
    fixture.retrieve.mockResolvedValueOnce({ status: "FAILED", operationId: "uncertain-retrieval", error: "movement_timeout", reconciliationRequired: true });
    expect(await executeRetrieval({ sourceBinCode: "B1-02", requestId: "uncertain" }))
      .toMatchObject({ ok: false, reason: "gantry_failed", message: expect.stringContaining("remains reserved") });
    expect(fixture.bin.status).toBe("RESERVED");
    expect(fixture.stock.quantity).toBe(12);
    expect(fixture.movements[0]).toMatchObject({ status: "FAILED", idempotencyKey: "retrieval:uncertain", gantryOperationId: "uncertain-retrieval" });
    expect(fixture.verify).not.toHaveBeenCalled();
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "uncertain" });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
  });

  it("preserves reservations and the original stock after an uncertain physical return", async () => {
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "before-uncertain-return" });
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/returned.jpg", capturedAt: new Date(), quantity: 10, simulated: false, inventoryUpdateApproved: true });
    fixture.returnBin.mockResolvedValueOnce({ status: "FAILED", operationId: "uncertain-return", error: "controller_error", reconciliationRequired: true });
    expect(await returnCheckedOutBin({ binCode: "B1-02" })).toMatchObject({ ok: false, reason: "gantry_failed" });
    expect(fixture.bin.status).toBe("RESERVED");
    expect(fixture.stock.quantity).toBe(12);
    expect(fixture.movements[1]).toMatchObject({ status: "FAILED", gantryOperationId: "uncertain-return" });
    expect(await returnCheckedOutBin({ binCode: "B1-02" })).toMatchObject({ ok: false, reason: "bin_unavailable" });
    expect(fixture.returnBin).toHaveBeenCalledOnce();
    expect(fixture.revert).not.toHaveBeenCalled();
  });
  it("moves to checkout before verification, then saves a trusted mismatch", async () => {
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/checked.jpg", capturedAt: new Date(),
      quantity: 10, simulated: true, inventoryUpdateApproved: true });
    const result = await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-1" });
    expect(result).toMatchObject({ ok: true, checkedOutQuantity: 10, binStatus: "CHECKED_OUT" });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(fixture.bin.status).toBe("CHECKED_OUT");
    expect(fixture.stock.quantity).toBe(10);
    expect(fixture.movements[0]).toMatchObject({ previousQuantity: 12, newQuantity: 10, status: "COMPLETED" });
  });

  it("verifies 12 at checkout and saves 11 on return after one item was taken", async () => {
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-2" });
    expect(fixture.events).toEqual(["retrieve", "verify"]);
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/returned.jpg", capturedAt: new Date(),
      quantity: 11, simulated: true, inventoryUpdateApproved: true });
    const returned = await returnCheckedOutBin({ binCode: "B1-02" });
    expect(returned).toMatchObject({ ok: true, inventoryQuantityBefore: 12, inventoryQuantityAfter: 11,
      inventoryQuantityRemoved: 1 });
    expect(fixture.stock.quantity).toBe(11);
    expect(fixture.bin.status).toBe("OCCUPIED");
    expect(fixture.returnBin).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledTimes(2);
    expect(fixture.revert).not.toHaveBeenCalled();
  });

  it("preserves checkout location and stock when a check is cancelled or fails", async () => {
    fixture.verify.mockRejectedValueOnce(new Error("Unexpected object; check cancelled"));
    const result = await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-3" });
    expect(result).toMatchObject({ ok: false, reason: "retrieval_verification_failed" });
    expect(fixture.bin.status).toBe("CHECKED_OUT");
    expect(fixture.stock.quantity).toBe(12);
    expect(fixture.movements[0]).toMatchObject({ status: "FAILED", idempotencyKey: "retrieval:user-3" });
    expect(fixture.returnBin).not.toHaveBeenCalled();
  });

  it("replays a corrected checkout without moving or verifying twice", async () => {
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/checked.jpg", capturedAt: new Date(),
      quantity: 10, simulated: false, inventoryUpdateApproved: true });
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-4" });
    const replay = await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-4" });
    expect(replay).toMatchObject({ ok: true, duplicate: true, checkedOutQuantity: 10 });
    expect(fixture.retrieve).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledOnce();
  });

  it("keeps plan fulfillment outside the new checkout-verification flow", async () => {
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "plan-1", verifyContents: false });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.stock.quantity).toBe(12);
    expect(fixture.movements[0].status).toBe("COMPLETED");
  });

  it("also corrects a trusted higher checkout count automatically", async () => {
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/checked.jpg", capturedAt: new Date(),
      quantity: 14, simulated: false, inventoryUpdateApproved: true });
    expect(await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-5" }))
      .toMatchObject({ ok: true, checkedOutQuantity: 14 });
    expect(fixture.stock.quantity).toBe(14);
  });

  it("returns an empty verified bin while retaining checkout identity until return", async () => {
    fixture.verify.mockResolvedValueOnce({ imageUrl: "/empty.jpg", capturedAt: new Date(),
      quantity: 0, simulated: false, inventoryUpdateApproved: true });
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-empty" });
    expect(fixture.stock.quantity).toBe(0);
    expect(await returnCheckedOutBin({ binCode: "B1-02" })).toMatchObject({ ok: true, inventoryQuantityAfter: 0 });
    expect(fixture.bin.status).toBe("AVAILABLE");
  });

  it("does not move back or update stock when return verification fails", async () => {
    await executeRetrieval({ sourceBinCode: "B1-02", requestId: "user-return-failure" });
    fixture.verify.mockRejectedValueOnce(new Error("Physical check uncertain"));
    const returned = await returnCheckedOutBin({ binCode: "B1-02" });
    expect(returned).toMatchObject({ ok: false, reason: "photo_required" });
    expect(fixture.stock.quantity).toBe(12);
    expect(fixture.bin.status).toBe("CHECKED_OUT");
    expect(fixture.returnBin).not.toHaveBeenCalled();
  });
});
