/**
 * Deterministic text search over the authoritative Part catalog.
 *
 * This is the service the agent's `search_catalog` / `search_inventory` tools
 * delegate to. It exists here, not in a Strands tool, so that a tool stays a
 * thin adapter and the same search is reusable by routes and tests.
 *
 * Deliberately NOT a vector database, embedding service or search engine: the
 * MVP catalog is small enough to rank in memory, and a deterministic ranking
 * is auditable in a way an approximate-nearest-neighbour index is not.
 *
 * Normalisation is shared with the catalog matcher (`normalizePartText` /
 * `tokenizePartText`) so "BRG-6204", "brg 6204" and "6204 bearing" tokenise
 * identically in both subsystems. The *ranking* below is search-only and is
 * not part of match scoring — matching remains catalog-matcher.ts's job.
 */
import { listParts } from "./repository";
import { normalizePartText, tokenizePartText } from "./catalog-matcher";
import type { Part } from "@/generated/prisma/client";

/** MVP assumption, matching the catalog matcher: rank the whole catalog in memory. */
const CATALOG_SCAN_LIMIT = 200;

export const DEFAULT_CATALOG_SEARCH_LIMIT = 5;
export const MAX_CATALOG_SEARCH_LIMIT = 10;

/**
 * A token containing a digit ("6204", "m8", "50") identifies a part far more
 * strongly than a plain word like "bolt", so it counts double when ranking.
 */
const IDENTIFIER_TOKEN_WEIGHT = 2;

/** An exact SKU hit outranks every token-overlap hit, whatever it scored. */
export const EXACT_SKU_SCORE = 1;

export type CatalogSearchReason = "exact_sku" | "token_overlap";

export interface CatalogSearchHit {
  part: Part;
  /** 0-1. 1 means an exact SKU match. */
  score: number;
  reason: CatalogSearchReason;
  /** Query tokens found on the part — the legible reason it ranked. */
  matchedTokens: string[];
}

/** "6204", "m8", "50" — the token that actually names a specific part. */
function isIdentifierToken(token: string): boolean {
  return /\d/.test(token);
}

function tokenWeight(token: string): number {
  return isIdentifierToken(token) ? IDENTIFIER_TOKEN_WEIGHT : 1;
}

/** Every token that could identify this part, across all its text fields. */
function searchableTokens(part: Part): Set<string> {
  return new Set([
    ...tokenizePartText(part.sku),
    ...tokenizePartText(part.canonicalName),
    ...tokenizePartText(part.category ?? ""),
    ...tokenizePartText(part.description ?? ""),
  ]);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_CATALOG_SEARCH_LIMIT;
  }
  return Math.min(limit, MAX_CATALOG_SEARCH_LIMIT);
}

/**
 * Ranks the catalog against free text (a SKU, a name, a category, or a
 * fragment like "6204 bearing"). Returns only parts with at least one shared
 * token, strongest first; ties break on SKU so the order is stable.
 */
export async function searchParts(
  query: string,
  limit?: number,
): Promise<CatalogSearchHit[]> {
  const normalizedQuery = normalizePartText(typeof query === "string" ? query : "");
  const queryTokens = tokenizePartText(normalizedQuery);
  if (queryTokens.length === 0) return [];

  const parts = await listParts({ limit: CATALOG_SCAN_LIMIT });
  const queryWeight = queryTokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  const queryIdentifiers = queryTokens.filter(isIdentifierToken);

  const hits: CatalogSearchHit[] = [];

  for (const part of parts) {
    // An exact SKU short-circuits ranking entirely — "BRG-6204" means that part.
    if (normalizePartText(part.sku) === normalizedQuery) {
      hits.push({
        part,
        score: EXACT_SKU_SCORE,
        reason: "exact_sku",
        matchedTokens: queryTokens,
      });
      continue;
    }

    const available = searchableTokens(part);
    const matchedTokens = queryTokens.filter((token) => available.has(token));
    if (matchedTokens.length === 0) continue;

    // When the query names a specific part ("BRG-9999", "6204", "M8"), a
    // candidate must match at least one of those identifiers. Without this,
    // "BRG-9999" matches BRG-6204 on the shared "brg" prefix alone and an
    // inventory question about a part we do not stock gets answered about a
    // part we do — the worst failure this tool layer can produce.
    if (queryIdentifiers.length > 0 && !matchedTokens.some(isIdentifierToken)) continue;

    const matchedWeight = matchedTokens.reduce((sum, token) => sum + tokenWeight(token), 0);
    hits.push({
      part,
      // Fraction of the *query* that the part accounts for, so a short precise
      // query is not penalised by a part carrying a long description.
      score: matchedWeight / queryWeight,
      reason: "token_overlap",
      matchedTokens,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.part.sku.localeCompare(b.part.sku));
  return hits.slice(0, clampLimit(limit));
}

/**
 * Resolves free text to exactly one catalog part, or explains why it could
 * not. Used by inventory lookups, where answering about the wrong part is
 * worse than admitting the query was ambiguous.
 *
 * A tie at the top is reported as ambiguous rather than broken arbitrarily —
 * the same principle the catalog matcher applies to AMBIGUOUS scans.
 */
export type PartResolution =
  | { status: "resolved"; part: Part }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: CatalogSearchHit[] };

export async function resolvePartQuery(query: string): Promise<PartResolution> {
  const hits = await searchParts(query, MAX_CATALOG_SEARCH_LIMIT);
  if (hits.length === 0) return { status: "not_found" };

  const [top, runnerUp] = hits;
  if (!runnerUp || top.score > runnerUp.score) return { status: "resolved", part: top.part };

  return { status: "ambiguous", candidates: hits.filter((hit) => hit.score === top.score) };
}
