import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const putawayCaptureUpdateMany = vi.fn();
  const putawayCaptureFindUnique = vi.fn();
  const movementUpdateMany = vi.fn();
  const snapshotFindFirst = vi.fn();
  const auditCaptureFindUnique = vi.fn();
  const auditCaptureFindFirst = vi.fn();
  const auditCaptureUpdateMany = vi.fn();
  const auditCaptureUpdate = vi.fn();
  const binUpdateMany = vi.fn();
  const binAuditUpdate = vi.fn();
  const inventoryFindUnique = vi.fn();
  const inventoryUpdate = vi.fn();
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
    work({
      putawayCaptureRequest: {
        updateMany: putawayCaptureUpdateMany,
      },
      movement: { updateMany: movementUpdateMany },
      auditCaptureRequest: {
        updateMany: auditCaptureUpdateMany,
        update: auditCaptureUpdate,
      },
      bin: { updateMany: binUpdateMany },
      binAudit: { update: binAuditUpdate },
      inventory: {
        findUnique: inventoryFindUnique,
        update: inventoryUpdate,
      },
    }),
  );
  return {
    putawayCaptureUpdateMany,
    putawayCaptureFindUnique,
    movementUpdateMany,
    snapshotFindFirst,
    auditCaptureFindUnique,
    auditCaptureFindFirst,
    auditCaptureUpdateMany,
    auditCaptureUpdate,
    binUpdateMany,
    binAuditUpdate,
    inventoryFindUnique,
    inventoryUpdate,
    transaction,
  };
});

vi.mock("@/lib/warehouse/db", () => ({
  prisma: {
    putawayCaptureRequest: {
      updateMany: mocks.putawayCaptureUpdateMany,
      findUnique: mocks.putawayCaptureFindUnique,
    },
    movement: {
      updateMany: mocks.movementUpdateMany,
      findFirst: mocks.snapshotFindFirst,
    },
    auditCaptureRequest: {
      findUnique: mocks.auditCaptureFindUnique,
      findFirst: mocks.auditCaptureFindFirst,
      updateMany: mocks.auditCaptureUpdateMany,
    },
    binAudit: {
      update: mocks.binAuditUpdate,
      findFirst: mocks.snapshotFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/camera/storage", () => ({
  readCameraCapture: vi.fn(),
}));

import {
  decideAuditCapture,
  pendingAuditCapture,
} from "@/lib/warehouse/audit-bin-service";
import { decidePutawayCapture } from "@/lib/warehouse/putaway-verification";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.putawayCaptureUpdateMany.mockResolvedValue({ count: 1 });
  mocks.movementUpdateMany.mockResolvedValue({ count: 1 });
  mocks.auditCaptureUpdateMany.mockResolvedValue({ count: 1 });
  mocks.auditCaptureUpdate.mockResolvedValue({});
  mocks.binUpdateMany.mockResolvedValue({ count: 1 });
  mocks.binAuditUpdate.mockResolvedValue({});
  mocks.inventoryFindUnique.mockResolvedValue({
    id: "inventory-1",
    quantity: 4,
  });
  mocks.inventoryUpdate.mockResolvedValue({});
  mocks.snapshotFindFirst.mockResolvedValue(null);
});

describe("five-second capture return", () => {
  it("does not expose unattended plan-analysis audits to the operator dialog", async () => {
    mocks.auditCaptureFindFirst.mockResolvedValue(null);

    await expect(pendingAuditCapture("owner-session")).resolves.toEqual({
      captureId: null,
    });

    expect(mocks.auditCaptureFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerSessionId: "owner-session",
          binAudit: {
            auditRun: { activeKey: "ACTIVE", trigger: "CLIENT" },
          },
        }),
      }),
    );
  });

  it("marks putaway verification for return without touching its movement quantity", async () => {
    await expect(
      decidePutawayCapture("putaway-capture", "AUTO_RETURN"),
    ).resolves.toEqual({ ok: true, status: "AUTO_RETURNED" });

    expect(mocks.putawayCaptureUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "putaway-capture" }),
        data: { status: "AUTO_RETURNED" },
      }),
    );
    expect(mocks.movementUpdateMany).not.toHaveBeenCalled();
  });

  it("writes the verified putaway quantity when the capture is accepted", async () => {
    mocks.putawayCaptureFindUnique.mockResolvedValue({
      id: "putaway-capture",
      status: "REVIEW_DECREASE",
      movementId: "movement-1",
      observedQuantity: 7,
      evidenceUrl: "/evidence/current.jpg",
      capturedAt: new Date("2026-09-12T12:00:00Z"),
      totalWeightGrams: 200,
      tareWeightGrams: 107,
      netWeightGrams: 83,
      unitWeightGrams: 11.857,
      weightSource: "SCALE",
    });

    await expect(
      decidePutawayCapture("putaway-capture", "ACCEPT"),
    ).resolves.toEqual({ ok: true, status: "ACCEPTED" });

    expect(mocks.movementUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "movement-1" }),
        data: expect.objectContaining({ newQuantity: 7 }),
      }),
    );
  });

  it("closes an audit and releases its bin without writing Inventory", async () => {
    mocks.auditCaptureFindUnique.mockResolvedValue({
      id: "audit-capture",
      status: "PENDING_ACK",
      expectedQuantity: 4,
      observedQuantity: 7,
      countConfidence: 0.98,
      countable: true,
      expectedPartPresent: true,
      foreignObjectSuspected: false,
      occlusion: "NONE",
      notes: "Seven visible units.",
      evidenceUrl: "/evidence/current.jpg",
      previousImageUrl: "/evidence/previous.jpg",
      capturedAt: new Date("2026-09-12T12:00:00Z"),
      binAudit: {
        id: "bin-audit",
        binId: "bin-1",
        expectedPartId: "part-1",
        bin: { id: "bin-1", capacity: 100 },
        expectedPart: { id: "part-1" },
      },
    });

    await expect(
      decideAuditCapture("audit-capture", "AUTO_RETURN"),
    ).resolves.toBeUndefined();

    expect(mocks.binUpdateMany).toHaveBeenCalledWith({
      where: { id: "bin-1", status: "AUDITING" },
      data: { status: "OCCUPIED" },
    });
    expect(mocks.binAuditUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bin-audit" },
        data: expect.objectContaining({
          status: "DISMISSED",
          inventoryUpdated: false,
          previousQuantity: 4,
          newQuantity: null,
          errorCode: "audit_auto_returned",
        }),
      }),
    );
    expect(mocks.inventoryUpdate).not.toHaveBeenCalled();
  });

  it("keeps the audit quantity write behind a manual click", async () => {
    mocks.auditCaptureFindUnique.mockResolvedValue({
      id: "audit-capture",
      status: "PENDING_ACK",
      expectedQuantity: 4,
      observedQuantity: 7,
      countConfidence: 0.98,
      countable: true,
      expectedPartPresent: true,
      foreignObjectSuspected: false,
      foreignObjectsJson: "[]",
      occlusion: "NONE",
      notes: "Seven visible units.",
      evidenceUrl: "/evidence/current.jpg",
      previousImageUrl: "/evidence/previous.jpg",
      capturedAt: new Date("2026-09-12T12:00:00Z"),
      binAudit: {
        id: "bin-audit",
        binId: "bin-1",
        expectedPartId: "part-1",
        bin: { id: "bin-1", capacity: 100 },
        expectedPart: { id: "part-1" },
      },
    });

    await expect(
      decideAuditCapture("audit-capture", "ACCEPT"),
    ).resolves.toBeUndefined();

    expect(mocks.inventoryUpdate).toHaveBeenCalledWith({
      where: { id: "inventory-1" },
      data: { quantity: 7 },
    });
    expect(mocks.binAuditUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_RECONCILED",
          inventoryUpdated: true,
          newQuantity: 7,
        }),
      }),
    );
  });
});
