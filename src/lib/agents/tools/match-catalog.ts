/**
 * match_catalog — does a scanned object correspond to a catalog part?
 *
 * READ-ONLY, and it does no matching of its own. It calls the Milestone 3
 * deterministic matcher and returns its verdict untouched, so MATCHED /
 * AMBIGUOUS / NO_MATCH keep exactly the meaning the thresholds give them. The
 * model interprets that verdict; it never replaces it, and it must not
 * promote AMBIGUOUS to an identity.
 *
 *   Strands tool -> matchScanToCatalog() -> decideCatalogMatch() -> catalog
 *
 * WHERE THE SCAN COMES FROM. Normally the request-scoped ScanResult the API
 * validated — see request-context.ts for why the model authoring scan dimensions
 * would defeat the whole measurement pipeline. A model-supplied `scanResult`
 * is accepted as a fallback, but the attached one always wins, and either way
 * `collectScanResultIssues` is the authority on validity.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { matchScanToCatalog } from "@/lib/warehouse/catalog-matcher";
import { isWarehouseError } from "@/lib/warehouse/errors";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { getContextScanResult } from "../request-context";
import { logTool, toolFailure } from "./tool-logging";
import { scanResultSchema } from "./scan-result-schema";

export const MATCH_CATALOG_TOOL_NAME = "match_catalog";

export const matchCatalogInputSchema = z.object({
  scanResult: scanResultSchema
    .optional()
    .describe(
      "Optional. Omit this: when the operator attaches a scan to the request, the server supplies it automatically and that copy is authoritative.",
    ),
});

export const matchCatalogTool = tool({
  name: MATCH_CATALOG_TOOL_NAME,
  description:
    "Compare the scan attached to this request against the part catalog using the deterministic catalog matcher, and return MATCHED, AMBIGUOUS or NO_MATCH with a confidence score, the scoring evidence and the ranked candidates. Use this only when the operator asks whether a scanned item corresponds to a catalog part. AMBIGUOUS means the identity is genuinely undecided and must not be resolved without operator confirmation. Read-only; it never creates a catalog part or records an identity.",
  inputSchema: matchCatalogInputSchema,
  callback: async ({ scanResult }) => {
    // Server-attached scan wins over anything the model supplied.
    const scan: ScanResult | null = getContextScanResult() ?? (scanResult as ScanResult | undefined) ?? null;

    if (!scan) {
      logTool(MATCH_CATALOG_TOOL_NAME, "-", "no_scan_result_available");
      return {
        ok: false as const,
        reason: "no_scan_result_available" as const,
        detail:
          "No scan is attached to this request. Ask the operator to scan the item first; a scan cannot be invented.",
      };
    }

    try {
      const result = await matchScanToCatalog(scan);
      logTool(
        MATCH_CATALOG_TOOL_NAME,
        `scanId="${scan.scanId}"`,
        `${result.status} confidence=${result.confidence.toFixed(2)}`,
      );
      // Returned verbatim: status, confidence, evidence, alternatives/candidates.
      return { ok: true as const, ...result };
    } catch (err) {
      // A malformed scan is a client mistake, not an internal failure.
      if (isWarehouseError(err) && err.code === "validation_failed") {
        logTool(MATCH_CATALOG_TOOL_NAME, "-", "invalid_scan_result");
        return {
          ok: false as const,
          reason: "invalid_scan_result" as const,
          issues: err.issues,
        };
      }
      return toolFailure(MATCH_CATALOG_TOOL_NAME, err);
    }
  },
});
