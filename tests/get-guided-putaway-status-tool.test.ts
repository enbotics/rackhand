import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "@/lib/agents/request-context";
import { getGuidedPutawayStatusTool } from "@/lib/agents/tools/get-guided-putaway-status";
import { getGuidedPutawayStatusForScan } from "@/lib/warehouse/guided-putaway-service";
import type { ScanResult } from "@/lib/warehouse/scan-types";

vi.mock("@/lib/warehouse/guided-putaway-service", () => ({
  getGuidedPutawayStatusForScan: vi.fn(),
}));

const SCAN = {
  scanId: "scan_status_1",
  capturedAt: 1_700_000_000_000,
  object: { detectedName: "bearing", description: "steel bearing" },
  dimensions: { lengthMM: 47, widthMM: 47, heightMM: 14 },
  quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.2 },
  orientation: { angleDegrees: 0 },
} satisfies ScanResult;

describe("get_guided_putaway_status tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports gantry and database states from the durable workflow", async () => {
    vi.mocked(getGuidedPutawayStatusForScan).mockResolvedValue({
      movementId: "movement_1",
      scanId: SCAN.scanId,
      part: {
        partId: "part_1",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
      },
      destinationBinCode: "B1-02",
      movementStatus: "AWAITING_PLACEMENT",
      databaseStatus: "WAITING_TO_SAVE",
      gantryStatus: "WAITING_FOR_PLACEMENT",
      gantryOperationId: "gantry_present_1",
      completedAt: null,
    });

    const result = await runWithRequestContext({ scanResult: SCAN }, () =>
      getGuidedPutawayStatusTool.invoke({}),
    );
    expect(result).toMatchObject({
      ok: true,
      found: true,
      workflow: {
        movementStatus: "AWAITING_PLACEMENT",
        databaseStatus: "WAITING_TO_SAVE",
        gantryStatus: "WAITING_FOR_PLACEMENT",
      },
    });
  });
});
