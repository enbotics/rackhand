"use client";

import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import type { MaterialsPlanCheckView } from "@/lib/warehouse/dashboard-types";
import { StatusChip } from "./ui";

const RUNNING_STATUSES = new Set(["PENDING", "RUNNING"]);

/** True while the unattended sweep is still walking bins. */
export function materialsCheckRunning(check: MaterialsPlanCheckView): boolean {
  return RUNNING_STATUSES.has(check.status);
}

type VerdictTone = "ok" | "warn" | "danger";

/**
 * Banner surfaces. The same border/background/text triples the shared TONE_CHIP
 * map uses, applied to a full-width block — WorkflowPanel's blocked/failed note
 * is the existing precedent for a card stating its outcome this way.
 */
const VERDICT_BANNER: Record<VerdictTone, string> = {
  ok: "border-success/40 bg-success-soft text-success",
  warn: "border-warn/40 bg-warn-soft text-warn",
  danger: "border-danger/40 bg-danger-soft text-danger",
};

export interface MaterialsCheckVerdict {
  tone: VerdictTone;
  /** The chip the pipeline header shows, so the header and the banner can never disagree. */
  chip: StatusPresentation;
  /** The bottom line, in one sentence an operator can read without reading the rows. */
  headline: string;
  /** Why that is the bottom line, and what it means for the build. */
  detail: string;
  readyCount: number;
  total: number;
}

/**
 * The one place the required-vs-available report is turned into a verdict.
 *
 * WHY IT IS SHARED: the pipeline header chip and the banner above the per-SKU
 * rows are two views of the same conclusion. Deriving each separately is how
 * a header that says READY ends up sitting above a banner that says nothing is
 * in stock, so both read this.
 *
 * Returns null when there is nothing to judge yet (no report, or a plan with
 * no requirements at all).
 */
export function materialsCheckVerdict(
  check: MaterialsPlanCheckView,
): MaterialsCheckVerdict | null {
  const results = check.results;
  if (!results || results.length === 0) return null;

  const total = results.length;
  const shortages = results.filter((result) => result.status === "SHORTAGE").length;
  const readyCount = total - shortages;
  const items = (count: number) => `${count} item${count === 1 ? "" : "s"}`;

  if (shortages === 0) {
    return {
      tone: "ok",
      chip: { label: "IN STOCK", tone: "ok", symbol: "✓" },
      headline: "Everything you need is in stock",
      detail: `All ${items(total)} were physically verified across ${check.binsPlanned} bin${
        check.binsPlanned === 1 ? "" : "s"
      }, in at least the quantities the plan calls for.`,
      readyCount,
      total,
    };
  }

  if (shortages === total) {
    return {
      tone: "danger",
      chip: { label: "NOT IN STOCK", tone: "danger", symbol: "✕" },
      headline:
        total === 1
          ? "The item you need is not in stock"
          : `None of the ${total} required materials are in stock`,
      // WHY TWO WORDINGS: binsPlanned === 0 is recordUnstartedCheck's path —
      // no sweep ran at all, either because nothing on the shelf is recorded
      // against these parts or because another audit already held the shelf
      // lock. Claiming "we checked and found nothing" there would be a lie
      // about a physical action that never happened, so it says so plainly.
      detail:
        check.binsPlanned === 0
          ? `No bins were audited: nothing on the shelf is currently recorded against these parts, or the shelf was busy with another audit. Every item is reported unavailable — the conservative reading. Nothing here can be built until they are sourced.`
          : `Every one of the ${check.binsPlanned} bin${
              check.binsPlanned === 1 ? "" : "s"
            } holding these parts was checked, and not one item reached the quantity the plan calls for. All ${items(
              total,
            )} need sourcing before this build can start.`,
      readyCount,
      total,
    };
  }

  return {
    tone: "warn",
    chip: { label: "SHORTAGE", tone: "warn", symbol: "!" },
    headline: `${shortages} of ${total} items ${shortages === 1 ? "is" : "are"} short`,
    detail: `${items(readyCount)} ${
      readyCount === 1 ? "is" : "are"
    } covered by what is on the shelf. The rest need restocking before this build can start.`,
    readyCount,
    total,
  };
}

/**
 * Step 2 of the build-plan pipeline: the unattended stock check.
 *
 * Three states, one body: live per-bin progress while the sweep runs, the
 * required/available report once it finishes, and an honest failure note if it
 * ends without producing one.
 *
 * The progress here is the one genuinely LIVE thing in this pipeline — it is
 * polled from a database row the sweep updates bin by bin, so it is named and
 * given the prominence of a real, currently-happening stage rather than being
 * a generic bar. Nothing else in this card guesses at what a model is doing.
 */
export function MaterialsCheckStage({ check }: { check: MaterialsPlanCheckView }) {
  const running = materialsCheckRunning(check);

  if (!running && !check.results) {
    // Terminal with no report. Rare, but it must never render as a progress
    // bar frozen at some percentage — that would read as "still working".
    return (
      <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-danger">
          Stock check did not finish
        </p>
        <p className="mt-1 text-xs leading-relaxed text-danger">
          The sweep ended as {check.status} without producing an availability report, so nothing
          was confirmed either way. Ask for the build plan again to re-run the check.
        </p>
      </div>
    );
  }

  if (running) {
    const percent =
      check.binsPlanned > 0 ? Math.round((check.binsCompleted / check.binsPlanned) * 100) : 0;
    return (
      <div className="space-y-2.5">
        <p className="text-xs leading-relaxed text-ink-muted">
          Every bin holding one of these parts is being audited, one at a time. Each is
          photographed and counted automatically and put straight back — nothing is moved out of
          the warehouse, and nothing here needs your input.
        </p>
        <div
          className="rounded-lg border border-accent-soft/40 bg-accent-tint px-3 py-2.5"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
              {check.currentBinCode
                ? `Now auditing bin ${check.currentBinCode}`
                : check.binsPlanned === 0
                  ? "Selecting the bins to check"
                  : "Moving to the next bin"}
            </p>
            <span className="shrink-0 font-mono text-[10px] tracking-[0.1em] text-accent">
              {percent}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 font-mono text-[10px] tracking-[0.1em] text-ink-muted">
            {check.binsCompleted} of {check.binsPlanned} bins checked
          </p>
        </div>
      </div>
    );
  }

  const results = check.results ?? [];
  const verdict = materialsCheckVerdict(check);
  // A part number alone is not what the operator asked about — they asked for
  // the thing it is FOR. The planner already said, so each row carries it.
  const purposeBySku = new Map(check.requirements.map((req) => [req.sku, req.purpose]));

  return (
    <div className="space-y-2.5">
      {verdict && (
        <div
          className={`rounded-lg border px-3 py-2.5 ${VERDICT_BANNER[verdict.tone]}`}
          role="status"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 text-xs font-semibold leading-relaxed">{verdict.headline}</p>
            <span className="shrink-0 font-mono text-[10px] tracking-[0.1em]">
              {verdict.readyCount}/{verdict.total} ready
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed opacity-90">{verdict.detail}</p>
        </div>
      )}

      {results.length === 0 && (
        <p className="text-xs leading-relaxed text-ink-faint">
          The check finished with nothing to report — the plan listed no parts to verify.
        </p>
      )}

      <ol className="space-y-1.5">
        {results.map((result) => (
          <li
            key={result.sku}
            className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-xs text-ink">
                {purposeBySku.get(result.sku) ?? result.sku}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                {result.sku} · {result.available} on the shelf · {result.required} needed
              </p>
            </div>
            <StatusChip
              status={
                result.status === "AVAILABLE"
                  ? { label: "AVAILABLE", tone: "ok", symbol: "✓" }
                  : { label: "SHORTAGE", tone: "warn", symbol: "!" }
              }
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
