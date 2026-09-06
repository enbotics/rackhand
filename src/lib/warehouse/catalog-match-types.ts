/**
 * The catalog-matching contract: given one ScanResult and the current Part
 * catalog, what did the matcher conclude and why.
 *
 * Types only, no runtime code and no server-only imports, so the browser can
 * render a match result without pulling in Prisma — same rule as
 * scan-types.ts.
 *
 * Matching is strictly read-only against catalog identity. A result never
 * implies a Part was created, inventory changed, or anything moved: it is an
 * opinion about identity, with the evidence attached so a human or (later) a
 * Strands agent can judge it rather than trusting a black box.
 */

/** Why a candidate scored the way it did. */
export interface MatchEvidence {
  /** 0-1 token-overlap similarity of detectedName against SKU + canonicalName + category. */
  nameScore: number;
  /** 0-1 orientation-insensitive dimensional agreement, or null when the catalog part has no planar dimensions. */
  dimensionScore: number | null;
  /** 0-1 description overlap, or null when either side has no description. */
  descriptionScore: number | null;
  /** 0-1 trust in the scan itself (Gemini fit confidence + mat calibration RMS). */
  scanQualityScore: number;
  /** Worst absolute error (mm) across the sorted planar pair, or null when not comparable. */
  planarDimensionErrorMM: number | null;
  /** Absolute height error (mm), or null when either side has no height. */
  heightErrorMM: number | null;
  /**
   * Distinctive digit-bearing tokens shared by the scan and the part, e.g.
   * ["6204"] or ["m8"]. The single most legible reason a match happened.
   */
  matchedIdentifierTokens: string[];
}

/** The catalog part a scan was matched to. Identity comes from the catalog, never from Gemini. */
export interface CatalogMatchPart {
  id: string;
  sku: string;
  canonicalName: string;
  category: string | null;
}

/** A ranked candidate, carrying enough detail for human review. */
export interface CatalogMatchAlternative {
  partId: string;
  sku: string;
  canonicalName: string;
  /** Weighted similarity before scan quality is applied. */
  score: number;
  /** `score` after the scan-quality adjustment — what the decision uses. */
  confidence: number;
  evidence: MatchEvidence;
}

/**
 * Exactly one of three states. Never collapse this to `{ sku: string | null }`
 * — the confidence and evidence are what later human-in-the-loop and agent
 * behaviour will act on.
 */
export type CatalogMatchResult =
  | {
      status: "MATCHED";
      confidence: number;
      matchedPart: CatalogMatchPart;
      evidence: MatchEvidence;
      /** Runners-up, strongest first. */
      alternatives: CatalogMatchAlternative[];
    }
  | {
      status: "AMBIGUOUS";
      confidence: number;
      /** Which condition stopped this being a MATCHED result. */
      reason: string;
      candidates: CatalogMatchAlternative[];
    }
  | {
      status: "NO_MATCH";
      confidence: number;
      reason: string;
      /** Closest candidates considered, even though none was plausible enough. */
      candidates: CatalogMatchAlternative[];
    };
