/**
 * Human catalog-identity resolution (Milestone 9).
 *
 * The matcher is never modified. This service sits beside it: when the
 * deterministic matcher returns AMBIGUOUS, it records the candidate set the
 * operator is allowed to choose from, and later records which one they chose.
 *
 * Everything here is identity only. Nothing in this file touches inventory,
 * bins, movements or the gantry — a human confirming what a part IS does not
 * approve moving it, and PutawayService revalidates all of that independently.
 */
import {
  catalogResolutionTraceId,
  completeTrace,
  recordEvent,
  startTrace,
} from "@/lib/observability/trace-service";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { matchScanToCatalog } from "./catalog-matcher";
import { collectScanResultIssues } from "./scan-result";
import { listParts } from "./repository";
import {
  RESOLUTION_TTL_MS,
  type CatalogResolutionRequestResult,
  type CatalogResolutionView,
  type ResolutionCandidate,
  type ResolutionDecisionResult,
  type ResolutionStatus,
} from "./catalog-resolution-types";
import type { ScanResult } from "./scan-types";
import type { CatalogResolution } from "@/generated/prisma/client";

function createResolutionId(): string {
  // Unguessable: a resolution id is an authorization to pick an identity.
  return `resolution_${randomUUID()}`;
}

function toView(row: CatalogResolution): CatalogResolutionView {
  return {
    resolutionId: row.id,
    scanId: row.scanId,
    status: row.status as ResolutionStatus,
    originalMatchStatus: row.originalMatchStatus,
    selectedPartId: row.selectedPartId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Lazily expires a pending row that has outlived its TTL.
 *
 * Expiry is applied on read rather than by a background sweeper: there is no
 * scheduler in this MVP, and a row that is never read again can never
 * authorize anything anyway.
 */
async function withExpiry(row: CatalogResolution): Promise<CatalogResolution> {
  if (row.status !== "PENDING" || row.expiresAt.getTime() > Date.now()) return row;
  return prisma.catalogResolution.update({
    where: { id: row.id },
    data: { status: "EXPIRED", resolvedAt: new Date() },
  });
}

/**
 * Runs the matcher for a scan and, only when it is AMBIGUOUS, opens a pending
 * human decision recording exactly which parts may be chosen.
 */
export async function requestCatalogResolution(
  scanResult: unknown,
): Promise<CatalogResolutionRequestResult> {
  // A person must not be allowed to override fundamentally invalid measurement
  // evidence — that is a rescan, not a judgement call.
  const issues = collectScanResultIssues(scanResult);
  if (issues.length > 0) return { status: "RESCAN_REQUIRED", issues };

  const scan = scanResult as ScanResult;
  const match = await matchScanToCatalog(scan);

  if (match.status === "MATCHED") {
    return {
      status: "MATCHED",
      partId: match.matchedPart.id,
      sku: match.matchedPart.sku,
      canonicalName: match.matchedPart.canonicalName,
      confidence: match.confidence,
    };
  }
  if (match.status === "NO_MATCH") {
    return { status: "NO_MATCH", reason: match.reason };
  }

  const parts = await listParts({ limit: 200 });
  const byId = new Map(parts.map((part) => [part.id, part]));
  const candidates: ResolutionCandidate[] = match.candidates.map((candidate) => {
    const part = byId.get(candidate.partId);
    return {
      partId: candidate.partId,
      sku: candidate.sku,
      canonicalName: candidate.canonicalName,
      confidence: candidate.confidence,
      dimensions: {
        lengthMM: part?.lengthMM ?? null,
        widthMM: part?.widthMM ?? null,
        heightMM: part?.heightMM ?? null,
      },
      evidence: candidate.evidence,
      imageUrl: part?.imageUrl ?? null,
    };
  });

  const expiresAt = new Date(Date.now() + RESOLUTION_TTL_MS);
  const row = await prisma.catalogResolution.create({
    data: {
      id: createResolutionId(),
      scanId: scan.scanId,
      originalMatchStatus: "AMBIGUOUS",
      // The authorized set, frozen at creation. A later request naming any
      // other part is refused however it is crafted.
      candidatePartIds: JSON.stringify(candidates.map((c) => c.partId)),
      status: "PENDING",
      expiresAt,
    },
  });

  // Milestone 12. A resolution arrives on its own HTTP request, so it gets its
  // own short trace rather than being grafted onto an agent turn it did not
  // belong to. The id is derived from the resolution id, which is how the later
  // CONFIRM or REJECT finds this same timeline.
  const resolutionTrace = await startTrace({
    traceId: catalogResolutionTraceId(row.id),
    requestSummary: `Identify scan ${scan.scanId}`,
  });
  await recordEvent(resolutionTrace, {
    type: "CATALOG_RESOLUTION_REQUIRED",
    status: "BLOCKED",
    name: row.id,
    summary: `Catalog match is ambiguous; an operator must choose between ${candidates
      .map((candidate) => candidate.sku)
      .join(", ")}.`,
    startedAt: new Date(),
    metadata: {
      resolutionId: row.id,
      scanId: scan.scanId,
      originalMatchStatus: "AMBIGUOUS",
      candidates: candidates.map((candidate) => candidate.sku),
    },
  });

  console.log(
    `[catalog-resolution] created=${row.id} scan=${scan.scanId} candidates=${candidates.map((c) => c.sku).join(",")}`,
  );

  return {
    status: "HUMAN_DECISION_REQUIRED",
    resolutionId: row.id,
    scanId: scan.scanId,
    reason: match.reason,
    expiresAt: expiresAt.toISOString(),
    candidates,
  };
}

export async function getCatalogResolution(id: string): Promise<CatalogResolution | null> {
  const row = await prisma.catalogResolution.findUnique({ where: { id } });
  return row ? withExpiry(row) : null;
}

/** The operator picks one of the offered candidates. */
export async function confirmCatalogResolution(
  id: string,
  partId: string,
): Promise<ResolutionDecisionResult> {
  const row = await getCatalogResolution(id);
  if (!row) {
    return { ok: false, reason: "resolution_not_found", message: `No resolution "${id}".` };
  }
  if (row.status === "EXPIRED") {
    return {
      ok: false,
      reason: "resolution_expired",
      message: "This identification request has expired. Scan the item again.",
    };
  }
  if (row.status !== "PENDING") {
    // CONFIRMED is immutable: switching the selected part afterwards would
    // rewrite history that stock may already depend on.
    return {
      ok: false,
      reason: "resolution_not_pending",
      message: `This identification is already ${row.status} and cannot be changed.`,
    };
  }

  const allowed: string[] = JSON.parse(row.candidatePartIds);
  if (!allowed.includes(partId)) {
    return {
      ok: false,
      reason: "candidate_not_allowed",
      message: "That part was not one of the offered candidates.",
    };
  }
  const part = await prisma.part.findUnique({ where: { id: partId } });
  if (!part) {
    return { ok: false, reason: "part_not_found", message: "That catalog part no longer exists." };
  }

  const updated = await prisma.catalogResolution.update({
    where: { id: row.id },
    data: { status: "CONFIRMED", selectedPartId: partId, resolvedAt: new Date() },
  });
  await recordEvent(catalogResolutionTraceId(row.id), {
    type: "CATALOG_RESOLUTION_CONFIRMED",
    status: "COMPLETED",
    name: row.id,
    // The choice and who is accountable for it — never any reasoning behind
    // it, the operator's or the matcher's.
    summary: `Operator identified this scan as ${part.sku} — ${part.canonicalName}.`,
    completedAt: new Date(),
    metadata: { resolutionId: row.id, scanId: row.scanId, selectedPartId: part.id, sku: part.sku },
  });
  await completeTrace(catalogResolutionTraceId(row.id), { status: "COMPLETED" });

  console.log(`[catalog-resolution] confirmed=${row.id} scan=${row.scanId} part=${part.sku}`);
  return { ok: true, resolution: toView(updated) };
}

/** "None of these are correct." Putaway stays blocked; no Part is created. */
export async function rejectCatalogResolution(id: string): Promise<ResolutionDecisionResult> {
  const row = await getCatalogResolution(id);
  if (!row) {
    return { ok: false, reason: "resolution_not_found", message: `No resolution "${id}".` };
  }
  if (row.status === "EXPIRED") {
    return { ok: false, reason: "resolution_expired", message: "This identification has expired." };
  }
  if (row.status !== "PENDING") {
    return {
      ok: false,
      reason: "resolution_not_pending",
      message: `This identification is already ${row.status}.`,
    };
  }

  const updated = await prisma.catalogResolution.update({
    where: { id: row.id },
    data: { status: "REJECTED", resolvedAt: new Date() },
  });
  await recordEvent(catalogResolutionTraceId(row.id), {
    type: "CATALOG_RESOLUTION_REJECTED",
    status: "BLOCKED",
    name: row.id,
    summary: "Operator rejected every candidate. No identity was recorded and putaway stays blocked.",
    completedAt: new Date(),
    metadata: { resolutionId: row.id, scanId: row.scanId },
  });
  await completeTrace(catalogResolutionTraceId(row.id), { status: "BLOCKED" });

  console.log(`[catalog-resolution] rejected=${row.id} scan=${row.scanId}`);
  return { ok: true, resolution: toView(updated) };
}

export { toView as toResolutionView };
