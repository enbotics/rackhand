import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { resolveCatalogIdentity } from "@/lib/warehouse/catalog-identity";
import { getPartById, listAvailableBins } from "@/lib/warehouse/repository";
import { runWithRequestContext } from "@/lib/agents/request-context";
import { requestGuidedPutawayTool } from "@/lib/agents/tools/request-guided-putaway";
import type { ScanResult } from "@/lib/warehouse/scan-types";

vi.mock("@/lib/warehouse/catalog-matcher", () => ({ matchScanToCatalog: vi.fn() }));
vi.mock("@/lib/warehouse/catalog-identity", () => ({ resolveCatalogIdentity: vi.fn() }));
vi.mock("@/lib/warehouse/repository", () => ({
  getPartById: vi.fn(),
  listAvailableBins: vi.fn(),
}));

const SCAN: ScanResult = {
  scanId: "scan_guided_agent_1",
  capturedAt: 1_700_000_000_000,
  object: { detectedName: "bearing", description: "steel bearing" },
  dimensions: { lengthMM: 47, widthMM: 47, heightMM: 14 },
  quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.2 },
  orientation: { angleDegrees: 0 },
};

describe("request_guided_putaway tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previews the guided workflow without reserving or mutating a slot", async () => {
    vi.mocked(matchScanToCatalog).mockResolvedValue({
      status: "MATCHED",
      confidence: 0.97,
      matchedPart: {
        id: "part_1",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        category: "bearing",
      },
      evidence: {
        nameScore: 0.9,
        dimensionScore: 0.95,
        descriptionScore: 0.5,
        scanQualityScore: 0.96,
        planarDimensionErrorMM: 0,
        heightErrorMM: 0,
        matchedIdentifierTokens: ["6204"],
      },
      alternatives: [],
    });
    vi.mocked(resolveCatalogIdentity).mockResolvedValue({
      ok: true,
      identity: { source: "DETERMINISTIC_MATCH", partId: "part_1" },
    });
    vi.mocked(getPartById).mockResolvedValue({
      id: "part_1",
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      category: "bearing",
      description: null,
      returnable: false,
      imageUrl: null,
      lengthMM: 47,
      widthMM: 47,
      heightMM: 14,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    vi.mocked(listAvailableBins).mockResolvedValue([
      {
        id: "bin_1",
        code: "B1-02",
        status: "AVAILABLE",
        capacity: 100,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);

    const result = await runWithRequestContext({ scanResult: SCAN }, () =>
      requestGuidedPutawayTool.invoke({}),
    );

    expect(result).toMatchObject({
      ok: true,
      status: "AWAITING_SLOT",
      scanId: SCAN.scanId,
      availableBins: [{ code: "B1-02", capacity: 100 }],
    });
    expect(listAvailableBins).toHaveBeenCalledOnce();
  });

  it("cannot invent a putaway when no server-attached scan exists", async () => {
    const result = await runWithRequestContext({}, () => requestGuidedPutawayTool.invoke({}));
    expect(result).toMatchObject({ ok: false, status: "BLOCKED", reason: "invalid_scan" });
    expect(matchScanToCatalog).not.toHaveBeenCalled();
  });
});
