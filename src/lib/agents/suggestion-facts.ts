/**
 * Real, concrete facts about current warehouse state that a chat "try this"
 * suggestion could be grounded in — nothing here is invented or guessed.
 *
 * WHY THIS EXISTS AS ITS OWN STEP. The empty-state suggestion chips used to
 * be a hardcoded array (`SUGGESTIONS`, removed in the "improved UI design"
 * pass) including lines like "Bring me BRG-6204." — a SKU that may not even
 * exist in this catalog. Replacing static text with a model that free-writes
 * suggestions from scratch would trade one problem for a worse one: it could
 * phrase something fluent that references a bin, part or quantity that isn't
 * real. So the FACTS are computed here, deterministically, straight from the
 * same warehouse snapshot the dashboard renders — a bin that is genuinely
 * OCCUPIED with stock, a real count of available bins, how long it has
 * actually been since an audit last completed. suggestion-generator.ts is
 * only ever allowed to turn these into prose, never to add to them.
 */
import { getWarehouseOverview } from "@/lib/warehouse/dashboard-service";
import type { WarehouseOverview } from "@/lib/warehouse/dashboard-types";

export type SuggestionFact =
  | { type: "fetchable_item"; binCode: string; partName: string; quantity: number }
  | { type: "available_capacity"; availableBins: number }
  | { type: "audit_due"; reason: "never_run" | "stale"; hoursSinceLastAudit: number | null }
  | { type: "build_plan_capability" };

/** Beyond this, a completed audit is no longer "recent" for suggestion purposes. */
const AUDIT_STALE_HOURS = 12;

/** Highest-signal facts first — callers cap the list before it reaches the model. */
export function deriveSuggestionFacts(overview: WarehouseOverview): SuggestionFact[] {
  const facts: SuggestionFact[] = [];

  const stockedBin = overview.bins.find(
    (bin) => bin.status === "OCCUPIED" && bin.contents.length > 0,
  );
  if (stockedBin) {
    const item = stockedBin.contents[0];
    facts.push({
      type: "fetchable_item",
      binCode: stockedBin.code,
      partName: item.canonicalName,
      quantity: item.quantity,
    });
  }

  const latestAudit = overview.latestAudit;
  if (!latestAudit) {
    facts.push({ type: "audit_due", reason: "never_run", hoursSinceLastAudit: null });
  } else if (latestAudit.completedAt !== null) {
    const hours = (Date.now() - latestAudit.completedAt) / (60 * 60 * 1000);
    if (hours > AUDIT_STALE_HOURS) {
      facts.push({ type: "audit_due", reason: "stale", hoursSinceLastAudit: Math.round(hours) });
    }
  }

  if (overview.totals.binsAvailable > 0) {
    facts.push({ type: "available_capacity", availableBins: overview.totals.binsAvailable });
  }

  // Always-true capability, not a claim about any specific project — safe to
  // offer even when nothing else about current state stands out.
  facts.push({ type: "build_plan_capability" });

  return facts;
}

export async function loadSuggestionFacts(): Promise<SuggestionFact[]> {
  return deriveSuggestionFacts(await getWarehouseOverview());
}
