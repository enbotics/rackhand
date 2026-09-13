import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const bin = { id: "bin-1", code: "B5-01", capacity: 100 };
  const movement = { id: "movement-1", type: "RETRIEVAL", status: "AWAITING_VERIFICATION",
    quantity: 12, previousQuantity: 12, newQuantity: null as number | null,
    destinationLocation: "OUTPUT", destinationBin: null, sourceBin: bin,
    part: { id: "part-1", sku: "SENSOR", canonicalName: "Sensor modules", lengthMM: 10, widthMM: 10, heightMM: 10 } };
  const capture: Record<string, unknown> = {};
  const updateCapture = vi.fn(async ({ where, data }: {
    where: { status?: string | { in: string[] }; attempt?: number };
    data: Record<string, unknown>;
  }) => {
    const allowed = typeof where.status === "string" ? [where.status] : where.status?.in;
    if ((allowed && !allowed.includes(capture.status as string))
      || (where.attempt !== undefined && capture.attempt !== where.attempt)) return { count: 0 };
    Object.assign(capture, data, { updatedAt: new Date() });
    return { count: 1 };
  });
  const database = {
    movement: {
      findUniqueOrThrow: vi.fn(async () => movement),
      findFirst: vi.fn(async () => ({ unitWeightGrams: 10 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(movement, data); return movement; }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(movement, data); return { count: 1 }; }),
    },
    putawayCaptureRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(capture, { id: "capture-1", status: "WAITING_FOR_CAMERA", attempt: 0, updatedAt: new Date(),
          observedQuantity: null, ...data, movement });
        return capture;
      }),
      findUnique: vi.fn(async () => capture),
      findUniqueOrThrow: vi.fn(async () => capture),
      updateMany: updateCapture,
    },
    cameraCaptureJob: {
      findFirst: vi.fn(async (): Promise<{
        id: string; requestedAt: Date; totalWeightGrams: number; weightSource: string;
      } | null> => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    binAudit: { findFirst: vi.fn(async () => null) },
  };
  return { movement, capture, database, inspect: vi.fn(), readCameraCapture: vi.fn() };
});

vi.mock("@/lib/warehouse/db", () => ({ prisma: { ...fixture.database,
  $transaction: vi.fn(async (callback: (tx: typeof fixture.database) => unknown) => callback(fixture.database)),
} }));
vi.mock("@/lib/camera/capture-job-service", () => ({
  createCaptureJob: async () => ({ id: "camera-1" }), captureProcessingHeartbeatMilliseconds: () => 1_000,
}));
vi.mock("@/lib/camera/storage", () => ({ readCameraCapture: fixture.readCameraCapture }));
vi.mock("@/lib/warehouse/bin-inspection-service", async () => ({
  ...await vi.importActual<typeof import("@/lib/warehouse/bin-inspection-service")>("@/lib/warehouse/bin-inspection-service"),
  inspectBinImage: fixture.inspect,
}));
vi.mock("@/lib/warehouse/putaway-recovery-service", () => ({
  recoverAbandonedPutaways: async () => ({}), putawayInactivityTimeoutMs: () => 240_000,
}));
vi.mock("@/lib/agents/request-context", () => ({ getContextWorkflowSessionId: () => "session-1", getContextBrowserScenario: () => null }));

import { decidePutawayCapture, processPutawayCameraCapture, reanalyzePutawayCapture, requirePutawayVerification } from "@/lib/warehouse/putaway-verification";
import { prisma } from "@/lib/warehouse/db";
import { GEMINI_VISION_MODEL_ID } from "@/lib/gemini-model";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.movement.status = "AWAITING_VERIFICATION";
  fixture.movement.newQuantity = null;
  fixture.movement.destinationLocation = "OUTPUT";
  for (const key of Object.keys(fixture.capture)) delete fixture.capture[key];
  fixture.inspect.mockResolvedValue({ countable: true, observedCount: 10, countConfidence: 0.8,
    expectedPartPresent: true, foreignObjectSuspected: false, foreignObjects: [], occlusion: "NONE", notes: "Clear check" });
});
afterEach(() => vi.useRealTimers());

async function startCheck() {
  const completion = requirePutawayVerification("movement-1");
  await vi.advanceTimersByTimeAsync(0);
  return { completion };
}

function processFrame(totalWeightGrams = 217, workflowAttempt = 0) {
  const now = new Date();
  return processPutawayCameraCapture("capture-1", { imageBuffer: Buffer.from("frame"),
    evidenceUrl: "/fresh.jpg", imageWidth: 100, imageHeight: 100, capturedAt: now, requestedAt: now,
    workflowAttempt, totalWeightGrams, weightSource: "SCALE", captureMode: "PROD" });
}

describe("physical verification state machine", () => {
  it("recovers a valid retrieval photo rejected by an older camera deployment", async () => {
    const { completion } = await startCheck();
    const now = new Date();
    Object.assign(fixture.capture, {
      status: "ANALYSIS_FAILED", evidenceUrl: "/saved.jpg", capturedAt: now,
      imageWidth: 100, imageHeight: 100,
      notes: "The saved photo could not be analyzed (This capture is stale or no longer pending.).",
    });
    fixture.readCameraCapture.mockResolvedValueOnce(Buffer.from("saved frame"));
    fixture.database.cameraCaptureJob.findFirst.mockResolvedValueOnce({
      id: "camera-1", requestedAt: now, totalWeightGrams: 217, weightSource: "SCALE",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.capture.status).toBe("REVIEW_DECREASE");
    expect(fixture.inspect).toHaveBeenCalledTimes(1);
    expect(fixture.readCameraCapture).toHaveBeenCalledWith("camera-1");
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ quantity: 10, inventoryUpdateApproved: true });
  });

  it("does not repeatedly recover a genuinely stale photo", async () => {
    const { completion } = await startCheck();
    const now = new Date();
    Object.assign(fixture.capture, {
      status: "ANALYSIS_FAILED", evidenceUrl: "/old.jpg", capturedAt: now,
      imageWidth: 100, imageHeight: 100,
      notes: "This capture is stale or no longer pending.",
    });
    fixture.readCameraCapture.mockResolvedValueOnce(Buffer.from("old frame"));
    fixture.database.cameraCaptureJob.findFirst.mockResolvedValueOnce({
      id: "camera-1", requestedAt: new Date(now.getTime() + 1_000),
      totalWeightGrams: 217, weightSource: "SCALE",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.readCameraCapture).toHaveBeenCalledTimes(1);
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.capture.status).toBe("ANALYSIS_FAILED");
    expect(fixture.movement.newQuantity).toBeNull();
    await decidePutawayCapture("capture-1", "CANCEL", "session-1");
    const failed = expect(completion).rejects.toThrow("verification failed");
    await vi.advanceTimersByTimeAsync(300);
    await failed;
  });

  it("uses the supported Gemini API model code rather than a display name", () => {
    expect(GEMINI_VISION_MODEL_ID).toBe("gemini-3.6-flash");
  });

  it("publishes the capture and ready movement marker in one transaction", async () => {
    const { completion } = await startCheck();
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(fixture.database.movement.update.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.database.putawayCaptureRequest.create.mock.invocationCallOrder[0],
    );
    expect(fixture.movement.destinationLocation).toBe("VERIFY_RETRIEVAL");
    await processFrame();
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ inventoryUpdateApproved: true });
  });

  it("still rejects an old retry attempt without analyzing or changing stock", async () => {
    const { completion } = await startCheck();
    await expect(processFrame(217, 99)).rejects.toThrow("stale or no longer pending");
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.capture.status).toBe("WAITING_FOR_CAMERA");
    expect(fixture.movement.newQuantity).toBeNull();
    await processFrame();
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ inventoryUpdateApproved: true });
  });

  it("reanalyzes a saved frame after a model error without taking another photo", async () => {
    const { completion } = await startCheck();
    fixture.inspect.mockRejectedValueOnce(new Error("models/gemini-3.5 is not found"));
    expect((await processFrame()).outcome).toBe("ANALYSIS_FAILED");
    expect(fixture.movement.newQuantity).toBeNull();
    fixture.readCameraCapture.mockResolvedValueOnce(Buffer.from("saved frame"));
    fixture.database.cameraCaptureJob.findFirst.mockResolvedValueOnce({
      id: "camera-1", requestedAt: fixture.capture.capturedAt as Date,
      totalWeightGrams: 217, weightSource: "SCALE",
    });
    expect((await reanalyzePutawayCapture("capture-1", "session-1")).outcome).toBe("REVIEW_DECREASE");
    expect(fixture.readCameraCapture).toHaveBeenCalledWith("camera-1");
    expect(fixture.inspect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ quantity: 10, inventoryUpdateApproved: true });
  });

  it("automatically accepts a trusted mismatch without a browser decision", async () => {
    const { completion } = await startCheck();
    const view = await processFrame();
    expect(view).toMatchObject({ operation: "RETRIEVAL", binCode: "B5-01", outcome: "REVIEW_DECREASE",
      expectedQuantity: 12, observedQuantity: 10, weightSource: "SCALE" });
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ quantity: 10, inventoryUpdateApproved: true });
    expect(fixture.capture.status).toBe("ACCEPTED");
    expect(fixture.movement.newQuantity).toBe(10);
    await expect(decidePutawayCapture("capture-1", "ACCEPT", "session-1")).resolves.toMatchObject({ status: "ACCEPTED" });
  });

  it("waits for human removal and retry when an unexpected object is present", async () => {
    const { completion } = await startCheck();
    fixture.inspect.mockResolvedValueOnce({ countable: true, observedCount: 10, countConfidence: 0.9,
      expectedPartPresent: true, foreignObjectSuspected: true, foreignObjects: ["key"], occlusion: "NONE", notes: "Key present" });
    expect((await processFrame()).outcome).toBe("FOREIGN_OBJECTS");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fixture.capture.status).toBe("RETRY_REQUIRED");
    expect(fixture.movement.newQuantity).toBeNull();
    await expect(decidePutawayCapture("capture-1", "ACCEPT", "session-1")).rejects.toThrow();
    await expect(decidePutawayCapture("capture-1", "AUTO_RETURN", "session-1")).rejects.toThrow();
    await decidePutawayCapture("capture-1", "RETRY", "session-1");
    // Prisma's increment is represented explicitly in this in-memory fixture.
    fixture.capture.attempt = 1;
    expect((await processFrame(217, 1)).outcome).toBe("REVIEW_DECREASE");
    await vi.advanceTimersByTimeAsync(5_500);
    await expect(completion).resolves.toMatchObject({ quantity: 10, inventoryUpdateApproved: true });
  });

  it("keeps stock unapproved when camera and scale disagree", async () => {
    const { completion } = await startCheck();
    expect((await processFrame(257)).outcome).toBe("LOW_CONFIDENCE");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fixture.movement.newQuantity).toBeNull();
    await decidePutawayCapture("capture-1", "CANCEL", "session-1");
    const failed = expect(completion).rejects.toThrow("verification failed");
    await vi.advanceTimersByTimeAsync(300);
    await failed;
  });
});
