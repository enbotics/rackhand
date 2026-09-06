/**
 * Deciding WHICH catalog part a scan is (Milestones 3, 9, 11).
 *
 * Extracted from putaway-service.ts so the Milestone 11 graph's identity node
 * and the Milestone 7 service run the SAME code rather than two implementations
 * that agree today. This is the rule that keeps a language model from choosing
 * a part it was explicitly forbidden from choosing, so it must exist exactly
 * once.
 *
 * THE RULES, unchanged from Milestone 9:
 *  - MATCHED  — the deterministic matcher is sure; identity is machine-derived.
 *  - AMBIGUOUS — stops, unless a CONFIRMED human resolution is supplied, and
 *    that resolution is re-loaded and re-checked here rather than believed
 *    because an id was passed in.
 *  - NO_MATCH — stops. There is nothing to resolve and no part to invent.
 *
 * A resolution is accepted only when it is CONFIRMED, belongs to THIS scan,
 * and its selected part is still inside the candidate set that was frozen when
 * the operator was asked. An id alone authorises nothing.
 */
import { getCatalogResolution } from "./catalog-resolution-service";
import type { CatalogMatchAlternative, CatalogMatchResult } from "./catalog-match-types";
import type { EffectiveCatalogIdentity } from "./catalog-resolution-types";

/** The subset of putaway failure reasons identity resolution can produce. */
export type CatalogIdentityFailureReason =
  | "catalog_no_match"
  | "catalog_match_ambiguous"
  | "catalog_resolution_invalid";

export type CatalogIdentityResult =
  | { ok: true; identity: EffectiveCatalogIdentity }
  | {
      ok: false;
      reason: CatalogIdentityFailureReason;
      message: string;
      /** Present for catalog_match_ambiguous, so an operator can see the tie. */
      candidates?: CatalogMatchAlternative[];
    };

export async function resolveCatalogIdentity(input: {
  scanId: string;
  /** The deterministic matcher's verdict for this scan. Never taken on trust from a caller. */
  match: CatalogMatchResult;
  catalogResolutionId?: string | null;
}): Promise<CatalogIdentityResult> {
  const { match, scanId } = input;

  if (match.status === "NO_MATCH") {
    return {
      ok: false,
      reason: "catalog_no_match",
      message:
        "This scanned object does not match an existing catalog Part, so putaway cannot proceed yet.",
    };
  }

  if (match.status === "MATCHED") {
    return { ok: true, identity: { source: "DETERMINISTIC_MATCH", partId: match.matchedPart.id } };
  }

  // AMBIGUOUS. Without a confirmed human decision this stops, exactly as in
  // Milestone 7 — the agent may never pick a candidate itself.
  if (!input.catalogResolutionId) {
    return {
      ok: false,
      reason: "catalog_match_ambiguous",
      message: `The catalog match is ambiguous, so putaway cannot proceed: ${match.reason}`,
      candidates: match.candidates,
    };
  }

  const resolution = await getCatalogResolution(input.catalogResolutionId);
  if (!resolution) {
    return {
      ok: false,
      reason: "catalog_resolution_invalid",
      message: "That identification does not exist.",
    };
  }
  if (resolution.status !== "CONFIRMED" || !resolution.selectedPartId) {
    return {
      ok: false,
      reason: "catalog_resolution_invalid",
      message: `That identification is ${resolution.status}, not CONFIRMED, so it cannot authorise a putaway.`,
    };
  }
  // Bound to one scan: a resolution for scan_123 can never authorise
  // scan_456, however similar the two scans look.
  if (resolution.scanId !== scanId) {
    return {
      ok: false,
      reason: "catalog_resolution_invalid",
      message: "That identification belongs to a different scan.",
    };
  }
  // Re-check the authorized candidate set, so a resolution confirmed before
  // the candidate list changed cannot smuggle in an unoffered part.
  const allowed: string[] = JSON.parse(resolution.candidatePartIds);
  if (!allowed.includes(resolution.selectedPartId)) {
    return {
      ok: false,
      reason: "catalog_resolution_invalid",
      message: "The identified part was not among the candidates offered for this scan.",
    };
  }

  return {
    ok: true,
    identity: {
      source: "HUMAN_RESOLUTION",
      partId: resolution.selectedPartId,
      resolutionId: resolution.id,
    },
  };
}
