/**
 * Deterministic catalog matching: does this ScanResult correspond to a Part
 * the catalog already knows?
 *
 * No second LLM call. Gemini already produced the semantic information
 * (detectedName, description) during measurement; this module combines that
 * structured output with the hard evidence the scanner is actually good at —
 * millimetres from the mat homography — and with how much the scan itself
 * can be trusted. Every function below is pure and testable except
 * `matchScanToCatalog`, which loads the catalog through the Milestone 2
 * repository.
 *
 * Strictly read-only. Matching never creates a Part, never invents a SKU,
 * never touches inventory, and never records a movement. It returns an
 * opinion plus the evidence behind it; acting on that opinion belongs to a
 * later milestone.
 */
import { listParts } from "./repository";
import { WarehouseError } from "./errors";
import { collectScanResultIssues } from "./scan-result";
import type { ScanDimensions, ScanQuality, ScanResult } from "./scan-types";
import type {
  CatalogMatchAlternative,
  CatalogMatchResult,
  MatchEvidence,
} from "./catalog-match-types";
import type { Part } from "@/generated/prisma/client";

/* ------------------------------------------------------------- constants */

/**
 * Signal weights for the blended similarity score. Dimensions and a specific
 * model/identifier token are the trustworthy signals for spare parts;
 * free-text description is corroborating colour, not identity, so it is
 * deliberately small. Weights are renormalized over whichever signals are
 * actually available for a given candidate.
 */
export const NAME_WEIGHT = 0.45;
export const DIMENSION_WEIGHT = 0.45;
export const DESCRIPTION_WEIGHT = 0.1;

/** Name score leans on recall — "6204 bearing" should match the longer "6204 Deep Groove Ball Bearing". */
const NAME_RECALL_SHARE = 0.75;
/** A digit-bearing token ("6204", "m8") is far more identifying than a word ("bearing"). */
const IDENTIFIER_TOKEN_WEIGHT = 3;
/** Extra credit when a distinctive token appears in the candidate's own SKU. */
const IDENTIFIER_SKU_BONUS = 0.1;

/**
 * Dimensional tolerance is absolute OR relative, whichever is larger: 2 mm
 * means something very different on a 10 mm bolt than on a 300 mm housing.
 * Inside the tolerance an axis scores 1.0; beyond it the score falls linearly
 * to 0 across a further DIMENSION_DECAY_MULTIPLIER x tolerance.
 *
 * These are pragmatic MVP numbers for a webcam + printed mat, chosen so a
 * ~0.5 mm measurement wobble is free while a different part size is clearly
 * penalized. This is NOT industrial metrology and must not be presented as
 * such.
 */
export const PLANAR_DIMENSION_TOLERANCE_MM = 2;
export const PLANAR_DIMENSION_TOLERANCE_RATIO = 0.05;
/** Height is the shakiest number a single overhead frame produces, so it gets a looser band. */
export const HEIGHT_TOLERANCE_MM = 2;
export const HEIGHT_TOLERANCE_RATIO = 0.1;
const DIMENSION_DECAY_MULTIPLIER = 2;
/** Planar agreement dominates the dimension score; height is weaker evidence. */
const PLANAR_SHARE_OF_DIMENSION_SCORE = 0.75;

/** Mat calibration RMS at/below which the pixel->mm mapping is considered clean, and at/above which it is untrustworthy. */
export const GOOD_CALIBRATION_RMS_PIXELS = 2;
export const POOR_CALIBRATION_RMS_PIXELS = 8;
/** Gemini's rectangle-fit confidence and the calibration fit count equally. */
const CONFIDENCE_SHARE_OF_QUALITY = 0.5;
/** A perfect scan loses nothing; a worthless scan loses this fraction of its similarity score. */
export const QUALITY_PENALTY_MAX = 0.35;

/**
 * A candidate with no catalog dimensions can never be confirmed outright —
 * name agreement alone is not identity for a physical part — so its
 * confidence is capped below MATCH_THRESHOLD, forcing AMBIGUOUS at best.
 */
export const UNCORROBORATED_CONFIDENCE_CAP = 0.7;

/** Decision thresholds. */
export const MATCH_THRESHOLD = 0.72;
/** Top candidate must beat the runner-up by this much, or the result is AMBIGUOUS. */
export const MATCH_MARGIN = 0.12;
/** Below this a candidate is not plausible enough to show as a real option. */
export const CANDIDATE_FLOOR = 0.35;
/** Never return the whole catalog. */
export const MAX_ALTERNATIVES = 3;

/** MVP assumption: the catalog is small enough to score entirely in memory. */
const CATALOG_SCAN_LIMIT = 200;

/* --------------------------------------------------------- text handling */

/** Words that carry no identifying signal for a spare part. Deliberately tiny — this is not an NLP framework. */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "with", "to", "in", "on", "by", "or", "mm", "x",
]);

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Lowercase, punctuation to spaces, whitespace collapsed. "BRG-6204" -> "brg 6204", "M8x50" -> "m8 50". */
export function normalizePartText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizePartText(text: string): string[] {
  const normalized = normalizePartText(text);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token !== "" && !STOPWORDS.has(token));
}

/** A token carrying a digit ("6204", "m8", "50") identifies a part far more than a plain word does. */
function isIdentifierToken(token: string): boolean {
  return /\d/.test(token);
}

function tokenWeight(token: string): number {
  return isIdentifierToken(token) ? IDENTIFIER_TOKEN_WEIGHT : 1;
}

function totalWeight(tokens: Iterable<string>): number {
  let sum = 0;
  for (const token of tokens) sum += tokenWeight(token);
  return sum;
}

/* -------------------------------------------------------- signal scoring */

/** The catalog-side fields a name comparison draws on. */
export interface NameMatchTarget {
  sku: string;
  canonicalName: string;
  category?: string | null;
}

export interface NameSimilarity {
  score: number;
  matchedIdentifierTokens: string[];
}

/**
 * Weighted token overlap between the scan's detected name and the candidate's
 * SKU + canonicalName + category.
 *
 * Recall-leaning on purpose: a short scan name ("6204 bearing") should still
 * score highly against a longer catalog name ("6204 Deep Groove Ball
 * Bearing"). A modest precision term keeps a sprawling catalog name from
 * matching everything, and a shared identifier token that also appears in the
 * SKU earns a bonus.
 */
export function scoreNameSimilarity(detectedName: string, part: NameMatchTarget): NameSimilarity {
  const scanTokens = new Set(tokenizePartText(detectedName));
  const skuTokens = new Set(tokenizePartText(part.sku));
  const partTokens = new Set([
    ...skuTokens,
    ...tokenizePartText(part.canonicalName),
    ...tokenizePartText(part.category ?? ""),
  ]);

  if (scanTokens.size === 0 || partTokens.size === 0) {
    return { score: 0, matchedIdentifierTokens: [] };
  }

  const shared = [...scanTokens].filter((token) => partTokens.has(token));
  const sharedWeight = totalWeight(shared);
  const recall = sharedWeight / totalWeight(scanTokens);
  const precision = sharedWeight / totalWeight(partTokens);

  let score = NAME_RECALL_SHARE * recall + (1 - NAME_RECALL_SHARE) * precision;

  const matchedIdentifierTokens = shared.filter(isIdentifierToken);
  if (matchedIdentifierTokens.some((token) => skuTokens.has(token))) {
    score += IDENTIFIER_SKU_BONUS;
  }

  return { score: clamp01(score), matchedIdentifierTokens };
}

/** Symmetric weighted overlap for prose. Null when either side has nothing to compare. */
export function scoreDescriptionSimilarity(
  scanDescription: string | null | undefined,
  partDescription: string | null | undefined,
): number | null {
  const scanTokens = new Set(tokenizePartText(scanDescription ?? ""));
  const partTokens = new Set(tokenizePartText(partDescription ?? ""));
  if (scanTokens.size === 0 || partTokens.size === 0) return null;

  const shared = [...scanTokens].filter((token) => partTokens.has(token));
  const union = new Set([...scanTokens, ...partTokens]);
  return clamp01(totalWeight(shared) / totalWeight(union));
}

/**
 * One axis: full credit inside the tolerance band, then a linear fall to zero.
 * Tolerance is max(absolute, ratio x catalog value) so both a 2 mm error on a
 * 10 mm bolt and a 5% error on a 300 mm housing are treated sensibly.
 */
function scoreDimensionAxis(
  measuredMM: number,
  catalogMM: number,
  toleranceMM: number,
  toleranceRatio: number,
): number {
  const allowed = Math.max(toleranceMM, toleranceRatio * Math.abs(catalogMM));
  const error = Math.abs(measuredMM - catalogMM);
  if (error <= allowed) return 1;
  return clamp01(1 - (error - allowed) / (allowed * DIMENSION_DECAY_MULTIPLIER));
}

/** Catalog-side dimensions, all optional. */
export interface DimensionMatchTarget {
  lengthMM: number | null;
  widthMM: number | null;
  heightMM: number | null;
}

export interface DimensionSimilarity {
  score: number | null;
  planarDimensionErrorMM: number | null;
  heightErrorMM: number | null;
}

/**
 * Orientation-insensitive dimensional agreement.
 *
 * The part lies on the mat at an arbitrary angle, so "length" and "width" are
 * whichever edge happened to be longer — 47x14 and 14x47 are the same part.
 * Both planar pairs are therefore sorted before comparison. Height is NOT
 * folded into that sort: it is a different physical axis and stays separate,
 * weaker evidence, and a missing height simply drops out rather than
 * penalizing the candidate.
 */
export function scoreDimensionSimilarity(
  scanDimensions: ScanDimensions,
  part: DimensionMatchTarget,
): DimensionSimilarity {
  if (part.lengthMM === null || part.widthMM === null) {
    return { score: null, planarDimensionErrorMM: null, heightErrorMM: null };
  }

  const [scanSmall, scanLarge] = [scanDimensions.lengthMM, scanDimensions.widthMM].sort((a, b) => a - b);
  const [partSmall, partLarge] = [part.lengthMM, part.widthMM].sort((a, b) => a - b);

  const planarScore =
    (scoreDimensionAxis(scanSmall, partSmall, PLANAR_DIMENSION_TOLERANCE_MM, PLANAR_DIMENSION_TOLERANCE_RATIO) +
      scoreDimensionAxis(scanLarge, partLarge, PLANAR_DIMENSION_TOLERANCE_MM, PLANAR_DIMENSION_TOLERANCE_RATIO)) /
    2;
  const planarDimensionErrorMM = Math.max(
    Math.abs(scanSmall - partSmall),
    Math.abs(scanLarge - partLarge),
  );

  if (scanDimensions.heightMM === null || part.heightMM === null) {
    return { score: planarScore, planarDimensionErrorMM, heightErrorMM: null };
  }

  const heightScore = scoreDimensionAxis(
    scanDimensions.heightMM,
    part.heightMM,
    HEIGHT_TOLERANCE_MM,
    HEIGHT_TOLERANCE_RATIO,
  );
  return {
    score:
      PLANAR_SHARE_OF_DIMENSION_SCORE * planarScore +
      (1 - PLANAR_SHARE_OF_DIMENSION_SCORE) * heightScore,
    planarDimensionErrorMM,
    heightErrorMM: Math.abs(scanDimensions.heightMM - part.heightMM),
  };
}

/**
 * How much this scan can be trusted at all, from Gemini's rectangle-fit
 * confidence and the mat homography's reprojection RMS. A confident-looking
 * similarity built on a badly calibrated frame should not read as certainty.
 */
export function scoreScanQuality(quality: ScanQuality): number {
  const confidence = clamp01(quality.dimensionConfidence);

  const rms = quality.calibrationRmsPixels;
  let calibration: number;
  if (rms <= GOOD_CALIBRATION_RMS_PIXELS) {
    calibration = 1;
  } else if (rms >= POOR_CALIBRATION_RMS_PIXELS) {
    calibration = 0;
  } else {
    calibration =
      1 - (rms - GOOD_CALIBRATION_RMS_PIXELS) / (POOR_CALIBRATION_RMS_PIXELS - GOOD_CALIBRATION_RMS_PIXELS);
  }

  return clamp01(CONFIDENCE_SHARE_OF_QUALITY * confidence + (1 - CONFIDENCE_SHARE_OF_QUALITY) * calibration);
}

/* ------------------------------------------------------ candidate scoring */

/** The catalog fields the matcher reads. Structurally satisfied by a Prisma `Part`. */
export interface CatalogCandidate extends NameMatchTarget, DimensionMatchTarget {
  id: string;
  description?: string | null;
}

export interface ScoredCandidate {
  candidate: CatalogCandidate;
  /** Blended similarity before scan quality. */
  score: number;
  /** `score` adjusted for scan quality (and capped when dimensions are unknown). */
  confidence: number;
  evidence: MatchEvidence;
}

/**
 * Blends the available signals, renormalizing the weights over whichever ones
 * this candidate actually has, then discounts by scan quality.
 */
export function scoreCatalogCandidate(
  scan: ScanResult,
  candidate: CatalogCandidate,
  scanQualityScore: number = scoreScanQuality(scan.quality),
): ScoredCandidate {
  const name = scoreNameSimilarity(scan.object.detectedName, candidate);
  const dimension = scoreDimensionSimilarity(scan.dimensions, candidate);
  const descriptionScore = scoreDescriptionSimilarity(scan.object.description, candidate.description);

  let weighted = NAME_WEIGHT * name.score;
  let available = NAME_WEIGHT;
  if (dimension.score !== null) {
    weighted += DIMENSION_WEIGHT * dimension.score;
    available += DIMENSION_WEIGHT;
  }
  if (descriptionScore !== null) {
    weighted += DESCRIPTION_WEIGHT * descriptionScore;
    available += DESCRIPTION_WEIGHT;
  }

  const score = clamp01(weighted / available);

  let confidence = clamp01(score * (1 - QUALITY_PENALTY_MAX * (1 - scanQualityScore)));
  if (dimension.score === null) {
    confidence = Math.min(confidence, UNCORROBORATED_CONFIDENCE_CAP);
  }

  return {
    candidate,
    score,
    confidence,
    evidence: {
      nameScore: name.score,
      dimensionScore: dimension.score,
      descriptionScore,
      scanQualityScore,
      planarDimensionErrorMM: dimension.planarDimensionErrorMM,
      heightErrorMM: dimension.heightErrorMM,
      matchedIdentifierTokens: name.matchedIdentifierTokens,
    },
  };
}

function toAlternative(scored: ScoredCandidate): CatalogMatchAlternative {
  return {
    partId: scored.candidate.id,
    sku: scored.candidate.sku,
    canonicalName: scored.candidate.canonicalName,
    score: scored.score,
    confidence: scored.confidence,
    evidence: scored.evidence,
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Development-only, one compact line per considered candidate. Never logs images or secrets. */
function logMatchTrace(scanId: string, ranked: ScoredCandidate[]): void {
  if (process.env.NODE_ENV === "production") return;
  for (const scored of ranked.slice(0, MAX_ALTERNATIVES + 1)) {
    console.log(
      `[catalog-match] scan=${scanId} candidate=${scored.candidate.sku} ` +
        `name=${round2(scored.evidence.nameScore)} ` +
        `dimensions=${scored.evidence.dimensionScore === null ? "n/a" : round2(scored.evidence.dimensionScore)} ` +
        `quality=${round2(scored.evidence.scanQualityScore)} ` +
        `final=${round2(scored.confidence)}`,
    );
  }
}

/**
 * Ranks a pre-loaded catalog against one scan and decides MATCHED /
 * AMBIGUOUS / NO_MATCH. Pure — no database access — so the decision logic is
 * directly testable; `matchScanToCatalog` is the thin wrapper that supplies
 * the catalog.
 *
 * The top candidate is never chosen merely for ranking first: it must clear
 * MATCH_THRESHOLD *and* beat the runner-up by MATCH_MARGIN. Two near-tied
 * bearings stay AMBIGUOUS for a human to settle.
 */
export function decideCatalogMatch(
  scan: ScanResult,
  candidates: CatalogCandidate[],
): CatalogMatchResult {
  const scanQualityScore = scoreScanQuality(scan.quality);

  if (candidates.length === 0) {
    return {
      status: "NO_MATCH",
      confidence: 0,
      reason: "The part catalog is empty — there is nothing to match against.",
      candidates: [],
    };
  }

  const ranked = candidates
    .map((candidate) => scoreCatalogCandidate(scan, candidate, scanQualityScore))
    .sort((a, b) => b.confidence - a.confidence);

  logMatchTrace(scan.scanId, ranked);

  const plausible = ranked.filter((scored) => scored.confidence >= CANDIDATE_FLOOR);

  if (plausible.length === 0) {
    return {
      status: "NO_MATCH",
      confidence: ranked[0].confidence,
      reason: `No catalog part reached the plausibility floor of ${CANDIDATE_FLOOR} (best was ${ranked[0].candidate.sku} at ${round2(ranked[0].confidence)}).`,
      candidates: ranked.slice(0, MAX_ALTERNATIVES).map(toAlternative),
    };
  }

  const [top, runnerUp] = plausible;
  const margin = top.confidence - (runnerUp?.confidence ?? 0);

  if (top.confidence >= MATCH_THRESHOLD && margin >= MATCH_MARGIN) {
    return {
      status: "MATCHED",
      confidence: top.confidence,
      matchedPart: {
        id: top.candidate.id,
        sku: top.candidate.sku,
        canonicalName: top.candidate.canonicalName,
        category: top.candidate.category ?? null,
      },
      evidence: top.evidence,
      alternatives: plausible.slice(1, 1 + MAX_ALTERNATIVES).map(toAlternative),
    };
  }

  const reason =
    top.confidence < MATCH_THRESHOLD
      ? `Best candidate ${top.candidate.sku} scored ${round2(top.confidence)}, below the match threshold of ${MATCH_THRESHOLD}.`
      : `${top.candidate.sku} (${round2(top.confidence)}) and ${runnerUp.candidate.sku} (${round2(runnerUp.confidence)}) are separated by only ${margin.toFixed(3)}, below the required margin of ${MATCH_MARGIN}.`;

  return {
    status: "AMBIGUOUS",
    confidence: top.confidence,
    reason,
    candidates: plausible.slice(0, MAX_ALTERNATIVES).map(toAlternative),
  };
}

/**
 * Public entry point — the shape a later Strands `match_catalog` tool will
 * call. Validates the scan with the Milestone 1 contract rules (a ScanResult
 * posted from a browser is untrusted input), loads the catalog through the
 * Milestone 2 repository, and returns the decision.
 *
 * Read-only: nothing here writes to the database.
 */
export async function matchScanToCatalog(scanResult: ScanResult): Promise<CatalogMatchResult> {
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) {
    throw new WarehouseError("validation_failed", "Invalid scanResult.", issues);
  }

  const parts: Part[] = await listParts({ limit: CATALOG_SCAN_LIMIT });
  return decideCatalogMatch(scanResult, parts);
}
