/**
 * Registering a scan as a BRAND-NEW catalog part — a deliberate human action,
 * never an automatic one.
 *
 * This is a different concept from catalog-identity.ts's identity resolution,
 * which stops cold on NO_MATCH and never invents a part — that rule is about
 * the deterministic pipeline never guessing an identity for a scan on its
 * own. Registration is the other side of that coin: a person, looking at
 * what the camera actually saw, deciding the catalog itself should grow. The
 * created Part is ordinary catalog data from that moment on — nothing here
 * short-circuits identity resolution or hands the new row special treatment.
 *
 * After registration, the caller is expected to re-run matchScanToCatalog
 * (see /api/warehouse/catalog/match): the new Part was built from this exact
 * scan's own detected name and dimensions, so the SAME deterministic matcher
 * used for everything else is what confirms the scan now has an identity —
 * this file never claims that for itself.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { createPart, getPartById } from "./repository";
import { matchScanToCatalog } from "./catalog-matcher";
import { uploadPutawayPhoto } from "./storage";
import { classifyReturnable } from "@/lib/agents/returnability-classifier";
import { collectScanResultIssues } from "./scan-result";
import { WarehouseError } from "./errors";
import type { ScanResult } from "./scan-types";
import type { Part } from "@/generated/prisma/client";

/** `NEW-A1B2C3D4` — unlikely to collide, and createPart's own unique-SKU guard is the real backstop. */
function generateSku(): string {
  return `NEW-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export type CatalogRegistrationResult =
  | { outcome: "created"; part: Part }
  /** The catalog changed underneath this request (e.g. someone else just
   *  registered the same object) and the scan already has an identity —
   *  registering again would create a needless duplicate SKU for the same
   *  physical thing. */
  | { outcome: "already_matched"; part: Part };

/**
 * Whether a human has already, explicitly said "none of the offered
 * candidates are this part" for this exact scan — a durable fact recorded by
 * rejectCatalogResolution, independent of what the deterministic matcher
 * itself still reports. The matcher does not change its mind: an AMBIGUOUS
 * scan stays AMBIGUOUS forever, because a REJECTED resolution doesn't erase
 * the candidates that made it plausible-looking in the first place. This is
 * what makes it safe to register anyway — the SAME kind of human judgement
 * call that already lets a CONFIRMED resolution authorise a putaway despite
 * the matcher never saying MATCHED.
 */
async function hasRejectedEveryCandidate(scanId: string): Promise<boolean> {
  const rejection = await prisma.catalogResolution.findFirst({
    where: { scanId, status: "REJECTED" },
  });
  return rejection !== null;
}

/**
 * Creates a new catalog Part directly from what THIS scan measured, so the
 * standard matcher can find it on a re-check. Callable in two situations,
 * both re-verified here rather than trusted from the caller:
 *  - the matcher currently says NO_MATCH, or
 *  - the matcher says AMBIGUOUS, but an operator has already explicitly
 *    rejected every candidate it offered for this exact scan.
 * Anything else (a live, unaddressed AMBIGUOUS, or an outright MATCHED) is
 * refused — the operator must resolve or reject before this file acts.
 */
export async function registerScanAsPart(
  scanResult: ScanResult,
  imageDataUrl?: string,
): Promise<CatalogRegistrationResult> {
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    throw new WarehouseError("validation_failed", "Invalid scanResult.", issues);
  }

  const freshMatch = await matchScanToCatalog(scanResult);
  if (freshMatch.status === "MATCHED") {
    return { outcome: "already_matched", part: await requirePart(freshMatch.matchedPart.id) };
  }
  if (freshMatch.status === "AMBIGUOUS" && !(await hasRejectedEveryCandidate(scanResult.scanId))) {
    throw new WarehouseError(
      "validation_failed",
      "This scan has plausible catalog candidates. Choose one, or reject every candidate first, before registering a new part.",
    );
  }

  const canonicalName = scanResult.object.detectedName.trim() || "Unnamed item";
  const returnable = await classifyReturnable({
    canonicalName,
    description: scanResult.object.description || null,
  });

  // Best-effort, exactly like guided-putaway-service's own photo upload: a
  // failed upload must never block the catalog from gaining this part.
  let imageUrl: string | null = null;
  if (imageDataUrl) {
    try {
      imageUrl = await uploadPutawayPhoto(scanResult.scanId, imageDataUrl);
    } catch (error) {
      console.error("[catalog-registration] photo upload failed, continuing without it:", error);
    }
  }

  const part = await createPart({
    sku: generateSku(),
    canonicalName,
    description: scanResult.object.description || null,
    lengthMM: scanResult.dimensions.lengthMM,
    widthMM: scanResult.dimensions.widthMM,
    heightMM: scanResult.dimensions.heightMM,
    returnable,
    imageUrl,
  });

  return { outcome: "created", part };
}

async function requirePart(id: string): Promise<Part> {
  const part = await getPartById(id);
  if (!part) throw new WarehouseError("part_not_found", "The matched part is no longer in the catalog.");
  return part;
}
