import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/warehouse/db";
import { createPart } from "@/lib/warehouse/repository";
import { executePutaway } from "@/lib/warehouse/putaway-service";
import {
  confirmCatalogResolution,
  getCatalogResolution,
  rejectCatalogResolution,
  requestCatalogResolution,
} from "@/lib/warehouse/catalog-resolution-service";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { resetWarehouse } from "./helpers";

/**
 * Milestone 9 identity resolution.
 *
 * The matcher is never touched: AMBIGUOUS stays AMBIGUOUS. What is tested here
 * is the separate human decision beside it, and that confirming an identity
 * settles ONLY the identity — every warehouse precondition still applies.
 */

const BOLT_HEX = {
  sku: "BOLT-M8-50",
  canonicalName: "M8 x 50 Hex Bolt",
  category: "fastener",
  description: "Zinc-plated steel hex head bolt",
  lengthMM: 50,
  widthMM: 13,
  heightMM: 5.3,
};
const BOLT_FLANGE = {
  sku: "BOLT-M8-50-FLG",
  canonicalName: "M8 x 50 Flange Bolt",
  category: "fastener",
  description: "Zinc-plated steel flange head bolt",
  lengthMM: 50,
  widthMM: 14,
  heightMM: 5.3,
};
const BEARING_6204 = {
  sku: "BRG-6204",
  canonicalName: "6204 Deep Groove Ball Bearing",
  category: "bearing",
  description: "Single-row deep groove ball bearing, 20mm bore",
  lengthMM: 47,
  widthMM: 47,
  heightMM: 14,
};

/** A scan that lands between the two M8 bolts, so the matcher is AMBIGUOUS. */
function ambiguousScan(scanId = "scan_1788574200123_amb"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200123,
    object: { detectedName: "M8 bolt", description: "Steel hex bolt" },
    dimensions: { lengthMM: 50.1, widthMM: 13.5, heightMM: 5.3 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

function bearingScan(scanId = "scan_1788574200999_brg"): ScanResult {
  return {
    scanId,
    capturedAt: 1788574200999,
    object: { detectedName: "6204 bearing", description: "Metal circular bearing." },
    dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };
}

beforeEach(async () => {
  await resetWarehouse();
  resetGantryController();
  await prisma.catalogResolution.deleteMany();
});

/* ------------------------------------------------------- creating one */

describe("requesting a resolution", () => {
  it("offers candidates only for an AMBIGUOUS match", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);

    const result = await requestCatalogResolution(ambiguousScan());
    expect(result.status).toBe("HUMAN_DECISION_REQUIRED");
    if (result.status !== "HUMAN_DECISION_REQUIRED") return;

    expect(result.candidates.map((c) => c.sku).sort()).toEqual([
      "BOLT-M8-50",
      "BOLT-M8-50-FLG",
    ]);
    expect(result.candidates[0].confidence).toBeGreaterThan(0);
    expect(result.candidates[0].evidence).toBeTruthy();
    expect(result.candidates[0].dimensions.lengthMM).toBe(50);
    expect(result.scanId).toBe("scan_1788574200123_amb");

    const row = await prisma.catalogResolution.findUniqueOrThrow({
      where: { id: result.resolutionId },
    });
    expect(row.status).toBe("PENDING");
    expect(row.originalMatchStatus).toBe("AMBIGUOUS");
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("does not open a decision for a confident match", async () => {
    await createPart(BEARING_6204);
    const result = await requestCatalogResolution(bearingScan());
    expect(result.status).toBe("MATCHED");
    expect(await prisma.catalogResolution.count()).toBe(0);
  });

  it("refuses to offer candidates for NO_MATCH", async () => {
    await createPart(BEARING_6204);
    const result = await requestCatalogResolution({
      ...bearingScan(),
      object: { detectedName: "rubber duck", description: "Yellow moulded toy" },
      dimensions: { lengthMM: 90, widthMM: 70, heightMM: 80 },
    });

    expect(result.status).toBe("NO_MATCH");
    // No list to pick from means no way to smuggle in an arbitrary identity.
    expect(await prisma.catalogResolution.count()).toBe(0);
  });

  it("requires a rescan instead of letting a person override a broken scan", async () => {
    await createPart(BOLT_HEX);
    const result = await requestCatalogResolution({ scanId: "scan_x", capturedAt: 1 });
    expect(result.status).toBe("RESCAN_REQUIRED");
    if (result.status === "RESCAN_REQUIRED") expect(result.issues.length).toBeGreaterThan(0);
    expect(await prisma.catalogResolution.count()).toBe(0);
  });
});

/* --------------------------------------------------------- deciding */

describe("deciding a resolution", () => {
  async function pending() {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const result = await requestCatalogResolution(ambiguousScan());
    if (result.status !== "HUMAN_DECISION_REQUIRED") throw new Error("expected ambiguity");
    return result;
  }

  it("confirms an offered candidate", async () => {
    const request = await pending();
    const chosen = request.candidates.find((c) => c.sku === "BOLT-M8-50")!;

    const decision = await confirmCatalogResolution(request.resolutionId, chosen.partId);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.resolution.status).toBe("CONFIRMED");
    expect(decision.resolution.selectedPartId).toBe(chosen.partId);
    expect(decision.resolution.resolvedAt).not.toBeNull();
  });

  it("refuses a part that was never offered", async () => {
    const request = await pending();
    const outsider = await createPart({ ...BEARING_6204 });

    const decision = await confirmCatalogResolution(request.resolutionId, outsider.id);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("candidate_not_allowed");

    const row = await getCatalogResolution(request.resolutionId);
    expect(row?.status).toBe("PENDING");
  });

  it("treats a confirmed decision as immutable", async () => {
    const request = await pending();
    const [first, second] = request.candidates;

    await confirmCatalogResolution(request.resolutionId, first.partId);
    const again = await confirmCatalogResolution(request.resolutionId, second.partId);

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("resolution_not_pending");
    const row = await getCatalogResolution(request.resolutionId);
    expect(row?.selectedPartId).toBe(first.partId);
  });

  it("records 'none of these' as a rejection without creating a Part", async () => {
    const request = await pending();
    const partsBefore = await prisma.part.count();

    const decision = await rejectCatalogResolution(request.resolutionId);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.resolution.status).toBe("REJECTED");
    expect(await prisma.part.count()).toBe(partsBefore);
  });

  it("expires a decision that was left too long", async () => {
    const request = await pending();
    await prisma.catalogResolution.update({
      where: { id: request.resolutionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const row = await getCatalogResolution(request.resolutionId);
    expect(row?.status).toBe("EXPIRED");

    const decision = await confirmCatalogResolution(
      request.resolutionId,
      request.candidates[0].partId,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("resolution_expired");
  });
});

/* ------------------------------------------------- putaway integration */

describe("putaway with a human-resolved identity", () => {
  async function confirmed(scanId = "scan_1788574200123_amb") {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const request = await requestCatalogResolution(ambiguousScan(scanId));
    if (request.status !== "HUMAN_DECISION_REQUIRED") throw new Error("expected ambiguity");
    const chosen = request.candidates.find((c) => c.sku === "BOLT-M8-50")!;
    await confirmCatalogResolution(request.resolutionId, chosen.partId);
    return { resolutionId: request.resolutionId, partId: chosen.partId, scanId };
  }

  it("still refuses an ambiguous scan with no resolution", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);

    const result = await executePutaway({ scanResult: ambiguousScan(), destinationBinCode: "B03" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("catalog_match_ambiguous");
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("proceeds with a CONFIRMED resolution, recording human provenance", async () => {
    const { resolutionId, scanId } = await confirmed();

    const result = await executePutaway({
      scanResult: ambiguousScan(scanId),
      destinationBinCode: "B03",
      catalogResolutionId: resolutionId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.part.sku).toBe("BOLT-M8-50");
    expect(result.identity).toEqual({
      source: "HUMAN_RESOLUTION",
      partId: result.part.partId,
      resolutionId,
    });

    const inventory = await prisma.inventory.findMany({ include: { bin: true, part: true } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].part.sku).toBe("BOLT-M8-50");
    expect(inventory[0].bin.code).toBe("B03");
  });

  it("records deterministic provenance when the matcher was confident", async () => {
    await createPart(BEARING_6204);
    const result = await executePutaway({ scanResult: bearingScan(), destinationBinCode: "B03" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.source).toBe("DETERMINISTIC_MATCH");
  });

  it("rejects a resolution belonging to a different scan", async () => {
    const { resolutionId } = await confirmed("scan_1788574200123_amb");

    const result = await executePutaway({
      scanResult: ambiguousScan("scan_1788574299999_other"),
      destinationBinCode: "B03",
      catalogResolutionId: resolutionId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("catalog_resolution_invalid");
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("rejects a resolution that is only PENDING", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const request = await requestCatalogResolution(ambiguousScan());
    if (request.status !== "HUMAN_DECISION_REQUIRED") throw new Error("expected ambiguity");

    const result = await executePutaway({
      scanResult: ambiguousScan(),
      destinationBinCode: "B03",
      catalogResolutionId: request.resolutionId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("catalog_resolution_invalid");
  });

  it("rejects a REJECTED resolution", async () => {
    await createPart(BOLT_HEX);
    await createPart(BOLT_FLANGE);
    const request = await requestCatalogResolution(ambiguousScan());
    if (request.status !== "HUMAN_DECISION_REQUIRED") throw new Error("expected ambiguity");
    await rejectCatalogResolution(request.resolutionId);

    const result = await executePutaway({
      scanResult: ambiguousScan(),
      destinationBinCode: "B03",
      catalogResolutionId: request.resolutionId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("catalog_resolution_invalid");
  });

  it("does not let a confirmed identity bypass bin validation", async () => {
    const { resolutionId, scanId } = await confirmed();
    // B03 is occupied by something else before the putaway runs.
    await createPart(BEARING_6204);
    const bearing = await prisma.part.findUniqueOrThrow({ where: { sku: "BRG-6204" } });
    const bin = await prisma.bin.findUniqueOrThrow({ where: { code: "B03" } });
    await prisma.inventory.create({ data: { partId: bearing.id, binId: bin.id, quantity: 1 } });
    await prisma.bin.update({ where: { id: bin.id }, data: { status: "OCCUPIED" } });

    const result = await executePutaway({
      scanResult: ambiguousScan(scanId),
      destinationBinCode: "B03",
      catalogResolutionId: resolutionId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bin_unavailable");
    expect(await getGantryController().getRecentOperations()).toEqual([]);
  });

  it("does not let a confirmed identity bypass idempotency", async () => {
    const { resolutionId, scanId } = await confirmed();
    const request = { scanResult: ambiguousScan(scanId), catalogResolutionId: resolutionId };

    const first = await executePutaway({ ...request, destinationBinCode: "B03" });
    const second = await executePutaway({ ...request, destinationBinCode: "B02" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.duplicate).toBe(true);
    expect(await prisma.inventory.count()).toBe(1);
    expect(await getGantryController().getRecentOperations()).toHaveLength(1);
  });
});
