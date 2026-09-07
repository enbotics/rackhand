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
import { createPart, getPartById } from "./repository";
import { matchScanToCatalog } from "./catalog-matcher";
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
 * Creates a new catalog Part directly from what THIS scan measured, so the
 * standard matcher can find it on a re-check. Only ever called for a scan the
 * matcher has already called NO_MATCH — re-verified here rather than trusted
 * from the caller, since the catalog can change between the operator seeing
 * NO_MATCH and clicking the button.
 */
export async function registerScanAsPart(scanResult: ScanResult): Promise<CatalogRegistrationResult> {
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    throw new WarehouseError("validation_failed", "Invalid scanResult.", issues);
  }

  const freshMatch = await matchScanToCatalog(scanResult);
  if (freshMatch.status === "MATCHED") {
    return { outcome: "already_matched", part: await requirePart(freshMatch.matchedPart.id) };
  }
  if (freshMatch.status !== "NO_MATCH") {
    // AMBIGUOUS: something in the catalog now looks plausible. Not this
    // file's call to make — an operator resolves that the normal way.
    throw new WarehouseError(
      "validation_failed",
      "This scan is no longer NO_MATCH — the catalog now has a plausible candidate. Resolve the ambiguity instead of registering a new part.",
    );
  }

  const canonicalName = scanResult.object.detectedName.trim() || "Unnamed item";
  const returnable = await classifyReturnable({
    canonicalName,
    description: scanResult.object.description || null,
  });

  const part = await createPart({
    sku: generateSku(),
    canonicalName,
    description: scanResult.object.description || null,
    lengthMM: scanResult.dimensions.lengthMM,
    widthMM: scanResult.dimensions.widthMM,
    heightMM: scanResult.dimensions.heightMM,
    returnable,
  });

  return { outcome: "created", part };
}

async function requirePart(id: string): Promise<Part> {
  const part = await getPartById(id);
  if (!part) throw new WarehouseError("part_not_found", "The matched part is no longer in the catalog.");
  return part;
}
