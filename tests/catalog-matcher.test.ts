import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { WarehouseError } from "@/lib/warehouse/errors";
import { createPart } from "@/lib/warehouse/repository";
import { addInventory } from "@/lib/warehouse/inventory-service";
import {
  CANDIDATE_FLOOR,
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  decideCatalogMatch,
  matchScanToCatalog,
  normalizePartText,
  scoreDimensionSimilarity,
  scoreNameSimilarity,
  scoreScanQuality,
  tokenizePartText,
  type CatalogCandidate,
} from "@/lib/warehouse/catalog-matcher";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { resetWarehouse } from "./helpers";

/** A well-measured scan of a 6204 bearing, unless overridden. */
function scanOf(overrides: {
  detectedName?: string;
  description?: string;
  lengthMM?: number;
  widthMM?: number;
  heightMM?: number | null;
  dimensionConfidence?: number;
  calibrationRmsPixels?: number;
} = {}): ScanResult {
  return {
    scanId: "scan_1788574200123_x8f21a",
    capturedAt: 1788574200123,
    object: {
      detectedName: overrides.detectedName ?? "6204 bearing",
      description: overrides.description ?? "Metal circular bearing with visible inner and outer races.",
    },
    dimensions: {
      lengthMM: overrides.lengthMM ?? 47.2,
      widthMM: overrides.widthMM ?? 46.9,
      heightMM: overrides.heightMM === undefined ? 14.1 : overrides.heightMM,
    },
    quality: {
      dimensionConfidence: overrides.dimensionConfidence ?? 0.96,
      calibrationRmsPixels: overrides.calibrationRmsPixels ?? 1.7,
    },
    orientation: { angleDegrees: 12.4 },
  };
}

const BEARING_6204: CatalogCandidate = {
  id: "part_6204",
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 20mm bore",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};

const BEARING_6205: CatalogCandidate = {
  id: "part_6205",
  sku: "BRG-6205",
  canonicalName: "6205 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 25mm bore",
  lengthMM: 52,
  widthMM: 52,
  heightMM: 15,
};

const BOLT_HEX: CatalogCandidate = {
  id: "part_bolt_hex",
  sku: "BOLT-M8-50-HEX",
  canonicalName: "M8 hex bolt",
  category: "fastener",
  description: "Zinc-plated steel hex head bolt",
  lengthMM: 50,
  widthMM: 13,
  heightMM: null,
};

const BOLT_FLANGE: CatalogCandidate = {
  id: "part_bolt_flange",
  sku: "BOLT-M8-50-FLG",
  canonicalName: "M8 flange bolt",
  category: "fastener",
  description: "Zinc-plated steel flange head bolt",
  lengthMM: 50,
  widthMM: 14,
  heightMM: null,
};

describe("text normalization", () => {
  it("normalizes punctuation, case and spacing", () => {
    expect(normalizePartText("  BRG-6204 ")).toBe("brg 6204");
    expect(normalizePartText("M8×50")).toBe("m8 50");
    expect(normalizePartText("6204   Deep_Groove")).toBe("6204 deep groove");
  });

  it("drops filler words but keeps identifying tokens", () => {
    expect(tokenizePartText("6204 Deep Groove Ball Bearing")).toEqual([
      "6204", "deep", "groove", "ball", "bearing",
    ]);
    expect(tokenizePartText("M8 x 50 Hex Bolt")).toEqual(["m8", "50", "hex", "bolt"]);
  });
});

describe("name similarity", () => {
  it("scores a short scan name strongly against a longer catalog name", () => {
    const { score, matchedIdentifierTokens } = scoreNameSimilarity("6204 bearing", BEARING_6204);
    expect(score).toBeGreaterThan(0.8);
    expect(matchedIdentifierTokens).toContain("6204");
  });

  it("separates a neighbouring model number", () => {
    const match = scoreNameSimilarity("6204 bearing", BEARING_6204);
    const neighbour = scoreNameSimilarity("6204 bearing", BEARING_6205);
    expect(match.score).toBeGreaterThan(neighbour.score + 0.4);
    expect(neighbour.matchedIdentifierTokens).toHaveLength(0);
  });

  it("gives a distinctive SKU token strong weight regardless of word order", () => {
    const direct = scoreNameSimilarity("6204 Deep Groove Ball Bearing", BEARING_6204);
    const reordered = scoreNameSimilarity("Ball bearing 6204", BEARING_6204);
    expect(reordered.score).toBeGreaterThan(0.7);
    expect(direct.score).toBeGreaterThan(0.7);
  });

  it("scores an unrelated name near zero", () => {
    expect(scoreNameSimilarity("Flexible jaw coupling", BEARING_6204).score).toBeLessThan(0.2);
  });
});

describe("dimension similarity", () => {
  it("is orientation-insensitive across the planar pair", () => {
    const upright = scoreDimensionSimilarity(
      { lengthMM: 47, widthMM: 14, heightMM: null },
      { lengthMM: 47, widthMM: 14, heightMM: null },
    );
    const rotated = scoreDimensionSimilarity(
      { lengthMM: 14, widthMM: 47, heightMM: null },
      { lengthMM: 47, widthMM: 14, heightMM: null },
    );
    expect(upright.score).toBe(1);
    expect(rotated.score).toBe(1);
    expect(rotated.planarDimensionErrorMM).toBe(0);
  });

  it("never swaps height into the planar comparison", () => {
    // Planar 47x14 with height 47 must not be read as "47x47x14".
    const result = scoreDimensionSimilarity(
      { lengthMM: 47, widthMM: 14, heightMM: 47 },
      { lengthMM: 47, widthMM: 47, heightMM: 14 },
    );
    expect(result.score).toBeLessThan(0.6);
    expect(result.heightErrorMM).toBe(33);
  });

  it("treats a missing height as absent evidence, not a penalty", () => {
    const withHeight = scoreDimensionSimilarity(
      { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
      BEARING_6204,
    );
    const withoutHeight = scoreDimensionSimilarity(
      { lengthMM: 47.2, widthMM: 46.9, heightMM: null },
      BEARING_6204,
    );
    expect(withHeight.score).toBe(1);
    expect(withoutHeight.score).toBe(1);
    expect(withoutHeight.heightErrorMM).toBeNull();
  });

  it("uses relative tolerance so the same mm error means different things by size", () => {
    // 2mm on a 10mm part is inside the absolute floor...
    const smallPart = scoreDimensionSimilarity(
      { lengthMM: 12, widthMM: 10, heightMM: null },
      { lengthMM: 10, widthMM: 10, heightMM: null },
    );
    // ...and 2mm on a 300mm part is comfortably inside the 5% band.
    const largePart = scoreDimensionSimilarity(
      { lengthMM: 302, widthMM: 300, heightMM: null },
      { lengthMM: 300, widthMM: 300, heightMM: null },
    );
    expect(smallPart.score).toBe(1);
    expect(largePart.score).toBe(1);

    // But 10mm on a 10mm part is a different part entirely.
    const wrongPart = scoreDimensionSimilarity(
      { lengthMM: 20, widthMM: 10, heightMM: null },
      { lengthMM: 10, widthMM: 10, heightMM: null },
    );
    expect(wrongPart.score).toBeLessThan(0.6);
  });

  it("returns null when the catalog part has no planar dimensions", () => {
    const result = scoreDimensionSimilarity(
      { lengthMM: 47, widthMM: 47, heightMM: 14 },
      { lengthMM: null, widthMM: null, heightMM: null },
    );
    expect(result.score).toBeNull();
    expect(result.planarDimensionErrorMM).toBeNull();
  });
});

describe("scan quality", () => {
  it("rewards a confident, well-calibrated scan", () => {
    expect(scoreScanQuality({ dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 })).toBeGreaterThan(0.97);
  });

  it("punishes poor calibration and low confidence", () => {
    const poor = scoreScanQuality({ dimensionConfidence: 0.3, calibrationRmsPixels: 9 });
    expect(poor).toBeLessThan(0.2);
  });

  it("degrades smoothly between the good and poor calibration bounds", () => {
    const mid = scoreScanQuality({ dimensionConfidence: 1, calibrationRmsPixels: 5 });
    expect(mid).toBeGreaterThan(0.7);
    expect(mid).toBeLessThan(0.8);
  });
});

describe("decideCatalogMatch", () => {
  it("MATCHED: strong name and dimensional agreement", () => {
    const result = decideCatalogMatch(scanOf(), [BEARING_6204, BEARING_6205, BOLT_HEX]);
    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") return;

    expect(result.matchedPart.sku).toBe("BRG-6204");
    expect(result.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(result.evidence.nameScore).toBeGreaterThan(0.8);
    expect(result.evidence.dimensionScore).toBe(1);
    expect(result.evidence.matchedIdentifierTokens).toContain("6204");
    expect(result.evidence.planarDimensionErrorMM).toBeLessThan(0.5);
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
    expect(result.alternatives.map((a) => a.sku)).not.toContain("BRG-6204");
  });

  it("MATCHED: name variation still matches when dimensions agree", () => {
    for (const detectedName of ["6204 bearing", "Ball bearing 6204", "bearing 6204 deep groove"]) {
      const result = decideCatalogMatch(scanOf({ detectedName }), [BEARING_6204, BEARING_6205]);
      expect(result.status, detectedName).toBe("MATCHED");
      if (result.status === "MATCHED") expect(result.matchedPart.sku).toBe("BRG-6204");
    }
  });

  it("MATCHED: planar rotation does not break the match", () => {
    const rotated = decideCatalogMatch(
      scanOf({ detectedName: "M8 hex bolt", lengthMM: 13.2, widthMM: 50.1, heightMM: null }),
      [BOLT_HEX],
    );
    expect(rotated.status).toBe("MATCHED");
    if (rotated.status === "MATCHED") {
      expect(rotated.matchedPart.sku).toBe("BOLT-M8-50-HEX");
      expect(rotated.evidence.dimensionScore).toBe(1);
    }
  });

  it("MATCHED: a null scan height still allows a strong match", () => {
    const result = decideCatalogMatch(scanOf({ heightMM: null }), [BEARING_6204, BEARING_6205]);
    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") return;
    expect(result.matchedPart.sku).toBe("BRG-6204");
    expect(result.evidence.heightErrorMM).toBeNull();
    expect(result.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("MATCHED: an exact SKU token drives the decision when dimensions agree", () => {
    const result = decideCatalogMatch(
      scanOf({ detectedName: "BRG-6204", description: "" }),
      [BEARING_6204, BEARING_6205],
    );
    expect(result.status).toBe("MATCHED");
    if (result.status === "MATCHED") {
      expect(result.matchedPart.sku).toBe("BRG-6204");
      expect(result.evidence.matchedIdentifierTokens).toContain("6204");
    }
  });

  it("does not MATCH on a good name when the dimensions disagree", () => {
    // Right family, wrong size: a 6204-labelled scan that measures like a 6205.
    const result = decideCatalogMatch(
      scanOf({ detectedName: "deep groove ball bearing", lengthMM: 120, widthMM: 118, heightMM: 30 }),
      [BEARING_6204, BEARING_6205],
    );
    expect(result.status).not.toBe("MATCHED");
    const best = result.status === "MATCHED" ? 1 : result.confidence;
    expect(best).toBeLessThan(MATCH_THRESHOLD);
  });

  it("AMBIGUOUS: two near-tied candidates are never guessed between", () => {
    const result = decideCatalogMatch(
      scanOf({
        detectedName: "M8 bolt",
        description: "Steel bolt",
        lengthMM: 50.2,
        widthMM: 13.5,
        heightMM: null,
      }),
      [BOLT_HEX, BOLT_FLANGE],
    );

    expect(result.status).toBe("AMBIGUOUS");
    if (result.status !== "AMBIGUOUS") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.sku).sort()).toEqual(["BOLT-M8-50-FLG", "BOLT-M8-50-HEX"]);
    const margin = result.candidates[0].confidence - result.candidates[1].confidence;
    expect(margin).toBeLessThan(MATCH_MARGIN);
    expect(result.reason).toMatch(/margin/i);
  });

  it("AMBIGUOUS: poor scan quality demotes an otherwise strong match", () => {
    const clean = decideCatalogMatch(scanOf(), [BEARING_6204]);
    const noisy = decideCatalogMatch(
      scanOf({ dimensionConfidence: 0.25, calibrationRmsPixels: 9 }),
      [BEARING_6204],
    );

    expect(clean.status).toBe("MATCHED");
    expect(noisy.status).toBe("AMBIGUOUS");
    expect(noisy.confidence).toBeLessThan(clean.confidence);
    if (noisy.status === "AMBIGUOUS") {
      expect(noisy.reason).toMatch(/threshold/i);
      expect(noisy.candidates[0].evidence.scanQualityScore).toBeLessThan(0.3);
    }
  });

  it("AMBIGUOUS at best when the catalog part has no dimensions to corroborate", () => {
    const dimensionless: CatalogCandidate = { ...BEARING_6204, lengthMM: null, widthMM: null, heightMM: null };
    const result = decideCatalogMatch(scanOf(), [dimensionless]);
    expect(result.status).toBe("AMBIGUOUS");
    if (result.status === "AMBIGUOUS") {
      expect(result.candidates[0].evidence.dimensionScore).toBeNull();
    }
  });

  it("NO_MATCH: nothing in the catalog resembles the scan", () => {
    const result = decideCatalogMatch(
      scanOf({
        detectedName: "Flexible jaw coupling",
        description: "Aluminium spider coupling",
        lengthMM: 72,
        widthMM: 38,
        heightMM: null,
      }),
      [BEARING_6204, BEARING_6205, BOLT_HEX, BOLT_FLANGE],
    );

    expect(result.status).toBe("NO_MATCH");
    if (result.status !== "NO_MATCH") return;
    expect(result.confidence).toBeLessThan(CANDIDATE_FLOOR);
    expect(result.reason).toMatch(/plausibility floor/i);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it("NO_MATCH: an empty catalog", () => {
    const result = decideCatalogMatch(scanOf(), []);
    expect(result.status).toBe("NO_MATCH");
    if (result.status === "NO_MATCH") {
      expect(result.confidence).toBe(0);
      expect(result.candidates).toHaveLength(0);
      expect(result.reason).toMatch(/empty/i);
    }
  });

  it("returns at most three alternatives, never the whole catalog", () => {
    const catalog = Array.from({ length: 12 }, (_, i) => ({
      ...BEARING_6204,
      id: `part_${i}`,
      sku: `BRG-620${i}`,
      canonicalName: `620${i} Deep Groove Ball Bearing`,
    }));
    const result = decideCatalogMatch(scanOf(), catalog);
    const listed = result.status === "MATCHED" ? result.alternatives : result.candidates;
    expect(listed.length).toBeLessThanOrEqual(3);
  });
});

describe("matchScanToCatalog (against the real catalog)", () => {
  beforeEach(async () => {
    await resetWarehouse();
    await createPart({
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      category: "bearing",
      description: "Single-row deep groove ball bearing, 20mm bore",
      lengthMM: 47,
      widthMM: 47,
      heightMM: 14,
    });
    await createPart({
      sku: "BRG-6205",
      canonicalName: "6205 Deep Groove Ball Bearing",
      category: "bearing",
      description: "Single-row deep groove ball bearing, 25mm bore",
      lengthMM: 52,
      widthMM: 52,
      heightMM: 15,
    });
  });

  it("matches a scan against catalog parts loaded through the repository", async () => {
    const result = await matchScanToCatalog(scanOf());
    expect(result.status).toBe("MATCHED");
    if (result.status === "MATCHED") {
      expect(result.matchedPart.sku).toBe("BRG-6204");
      expect(result.matchedPart.id).toBeTruthy();
      expect(result.matchedPart.category).toBe("bearing");
    }
  });

  it("rejects a malformed ScanResult with field-level issues", async () => {
    const broken = {
      ...scanOf(),
      dimensions: { lengthMM: -1, widthMM: Number.NaN, heightMM: 0 },
      quality: { dimensionConfidence: 4, calibrationRmsPixels: -2 },
    };

    await expect(matchScanToCatalog(broken as unknown as ScanResult)).rejects.toBeInstanceOf(WarehouseError);
    try {
      await matchScanToCatalog(broken as unknown as ScanResult);
    } catch (err) {
      const error = err as WarehouseError;
      expect(error.code).toBe("validation_failed");
      expect(error.status).toBe(422);
      expect(error.issues.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("rejects entirely absent or non-object input", async () => {
    for (const bad of [undefined, null, "scan", 42, []]) {
      await expect(matchScanToCatalog(bad as unknown as ScanResult)).rejects.toBeInstanceOf(WarehouseError);
    }
  });

  it("mutates nothing — no catalog, inventory or movement writes", async () => {
    await addInventory({ sku: "BRG-6204", binCode: "A01", quantity: 3 });

    const before = {
      parts: await prisma.part.findMany({ orderBy: { sku: "asc" } }),
      inventory: await prisma.inventory.findMany(),
      movements: await prisma.movement.count(),
      bins: await prisma.bin.findMany({ orderBy: { code: "asc" } }),
    };

    await matchScanToCatalog(scanOf());
    await matchScanToCatalog(scanOf({ detectedName: "Flexible jaw coupling", lengthMM: 72, widthMM: 38 }));

    expect(await prisma.part.findMany({ orderBy: { sku: "asc" } })).toEqual(before.parts);
    expect(await prisma.inventory.findMany()).toEqual(before.inventory);
    expect(await prisma.movement.count()).toBe(before.movements);
    expect(await prisma.bin.findMany({ orderBy: { code: "asc" } })).toEqual(before.bins);
  });
});
