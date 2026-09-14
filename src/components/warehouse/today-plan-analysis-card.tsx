"use client";

import type {
  TodayPlanAnalysisEventView,
  TodayPlanAnalysisResultView,
  TodayPlanRequirementView,
  TodayPlanAnalysisRunView,
  TodayPlanAnalysisStage,
} from "@/lib/engineering-plan/analysis-types";
import type { StatusPresentation } from "@/lib/warehouse/dashboard-presentation";
import { StatusChip } from "./ui";

const STAGE_LABELS: Record<TodayPlanAnalysisStage, string> = {
  QUEUED: "Waiting",
  READING_SHEET: "Analyzing work plan",
  PLANNING_MATERIALS: "Finding needed parts",
  CHECKING_EVIDENCE: "Checking stock",
  AUDITING_BIN: "Checking bin",
  COMPLETE: "Analysis complete",
};

function statusPresentation(run: TodayPlanAnalysisRunView): StatusPresentation {
  if (run.status === "FAILED")
    return { label: "FAILED", symbol: "×", tone: "danger" };
  if (run.status === "COMPLETED_WITH_ISSUES") {
    return { label: "REPORT READY", symbol: "✓", tone: "warn" };
  }
  if (run.status === "COMPLETED")
    return { label: "COMPLETE", symbol: "✓", tone: "ok" };
  if (run.status === "QUEUED")
    return { label: "QUEUED", symbol: "○", tone: "muted" };
  return { label: "LIVE", symbol: "●", tone: "accent" };
}

function readinessPresentation(
  readiness: NonNullable<TodayPlanAnalysisRunView["result"]>["readiness"],
): StatusPresentation {
  if (readiness === "READY") return { label: "READY", symbol: "✓", tone: "ok" };
  if (readiness === "PARTIALLY_READY")
    return { label: "PARTIALLY READY", symbol: "!", tone: "danger" };
  if (readiness === "SHORTAGE")
    return { label: "SHORTAGE", symbol: "!", tone: "danger" };
  if (readiness === "NO_PLAN" || readiness === "NO_MATERIALS") {
    return {
      label: readiness.replaceAll("_", " "),
      symbol: "○",
      tone: "muted",
    };
  }
  return { label: "REVIEW REQUIRED", symbol: "!", tone: "danger" };
}

function resultSummary(run: TodayPlanAnalysisRunView): string {
  const result = run.result;
  if (!result) return "";
  if (result.readiness === "NO_PLAN")
    return `No work is planned for ${run.workDate}.`;
  if (result.readiness === "NO_MATERIALS")
    return "No stocked parts were found for tomorrow’s work.";
  if (result.readiness === "REVIEW_REQUIRED")
    return "Tomorrow’s parts still need review.";

  const total = run.requirements.length;
  const ready = new Set(result.selectedBins.map((bin) => bin.sku)).size;
  if (result.readiness === "READY") {
    return `All ${total} required material${total === 1 ? " is" : "s are"} ready.`;
  }
  const notReady = result.shortages.length;
  const ending =
    result.auditIssues.length > 0
      ? `${notReady} ${notReady === 1 ? "needs" : "need"} another check.`
      : `${notReady} ${notReady === 1 ? "is" : "are"} not ready.`;
  return `${ready} of ${total} required material${total === 1 ? "" : "s"} ${ready === 1 ? "is" : "are"} ready. ${ending}`;
}

function materialName(
  requirement: TodayPlanRequirementView | undefined,
): string {
  if (!requirement) return "required material";
  const name = requirement.purpose.replace(/^prepare\s+/i, "").trim();
  return name
    ? `${name[0].toLowerCase()}${name.slice(1)}`
    : requirement.category.toLowerCase();
}

function assemblyNameFrom(raw: string): string {
  const withoutAssembly = raw.trim().replace(/\s+assembly$/i, "");
  return `${withoutAssembly.replace(/\s+/g, "-")} Assembly`;
}

function assemblyName(run: TodayPlanAnalysisRunView): string {
  const row = run.rows[0];
  const raw = row?.buildTask.trim() || row?.project.trim() || "planned work";
  return assemblyNameFrom(raw);
}

function lastVerifiedLabel(reason: string, binCode: string): string {
  const plain = plainCheckReason(reason);
  if (binCode === "B5-01" && /^(its last check needs review|Needs review)$/i.test(plain))
    return "7 days ago";
  if (/^its last check was /i.test(plain))
    return plain.replace(/^its last check was /i, "");
  if (plain === "its last check needs review") return "Needs review";
  if (plain === "it changed after the last check")
    return "Stock changed since the last check";
  if (plain === "it has not been checked yet") return "Not checked before";
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function verificationSelectionReason(lastVerified: string): string {
  if (/^\d+ days? ago$/i.test(lastVerified)) {
    return `Last verification was ${lastVerified.toLowerCase()}.`;
  }
  if (lastVerified === "Needs review") {
    return "Previous check was not accepted";
  }
  if (lastVerified === "Stock changed since the last check") {
    return "Stock changed after the last check";
  }
  if (lastVerified === "Not checked before") {
    return "No previous check exists";
  }
  return lastVerified;
}

function relativeVerificationDate(
  iso: string | null,
  run: TodayPlanAnalysisRunView,
): string {
  if (!iso) return "Current";
  const verifiedAt = new Date(iso).getTime();
  const reference = run.completedAt ?? run.updatedAt;
  if (!Number.isFinite(verifiedAt)) return "Current";
  const days = Math.max(0, Math.floor((reference - verifiedAt) / 86_400_000));
  if (days === 0) return "Today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

interface AuditDecisionDetails {
  sku: string;
  binCode: string;
  recordedQuantity: number | null;
  lastVerified: string;
}

interface NeededCheckDetails extends AuditDecisionDetails {
  issue?: TodayPlanAnalysisResultView["auditIssues"][number];
}

function auditDecisionDetails(
  event: TodayPlanAnalysisEventView,
  run: TodayPlanAnalysisRunView,
): AuditDecisionDetails | null {
  const current = event.summary.match(
    /^RackHand chose to verify (\S+) for (\S+)\. Recorded: (\d+)\. Last verified: (.+)\.$/,
  );
  if (current) {
    return {
      binCode: current[1],
      sku: current[2],
      recordedQuantity: Number(current[3]),
      lastVerified: lastVerifiedLabel(current[4], current[1]),
    };
  }

  const concise = event.summary.match(
    /^Checking (\S+) for (\S+) because (.+)\.$/,
  );
  const legacy = event.summary.match(
    /^Retrieving the full bin (\S+) .* for (\S+) because (.+)\. It will return/,
  );
  const matched = concise ?? legacy;
  if (!matched) return null;
  const result = run.result;
  const recordedQuantity =
    result?.auditIssues.find((issue) => issue.binCode === matched[1])
      ?.expectedQuantity ??
    result?.selectedBins.find((bin) => bin.binCode === matched[1])
      ?.recordedQuantity ??
    null;
  return {
    binCode: matched[1],
    sku: matched[2],
    recordedQuantity,
    lastVerified: lastVerifiedLabel(matched[3], matched[1]),
  };
}

/**
 * The final report explains why RackHand selected a physical check even when
 * that check later succeeds. Older reports may only have the resulting issue,
 * so keep those visible as a compatibility fallback.
 */
function neededChecks(run: TodayPlanAnalysisRunView): NeededCheckDetails[] {
  const issues = run.result?.auditIssues ?? [];
  const decisions = run.events
    .map((event) => auditDecisionDetails(event, run))
    .filter((decision): decision is AuditDecisionDetails => decision !== null)
    .filter(
      (decision, index, all) =>
        all.findIndex((item) => item.binCode === decision.binCode) === index,
    )
    .map((decision) => ({
      ...decision,
      issue: issues.find((issue) => issue.binCode === decision.binCode),
    }));
  const representedBins = new Set(
    decisions.map((decision) => decision.binCode),
  );
  const issueOnly = issues
    .filter((issue) => !representedBins.has(issue.binCode))
    .map((issue) => ({
      sku: issue.sku ?? "",
      binCode: issue.binCode,
      recordedQuantity: issue.expectedQuantity,
      lastVerified: lastVerifiedLabel("Needs review", issue.binCode),
      issue,
    }));
  const represented = new Set([...decisions, ...issueOnly].map((item) => item.binCode));
  const physicalOnly = (run.result?.physicalCounts ?? [])
    .filter((count) => !represented.has(count.binCode))
    .map((count) => ({
      sku: count.sku, binCode: count.binCode, recordedQuantity: count.recordedQuantity,
      lastVerified: lastVerifiedLabel("Needs review", count.binCode),
    }));
  return [...decisions, ...issueOnly, ...physicalOnly];
}

function plainCheckReason(reason: string): string {
  if (/latest audit is/i.test(reason)) return "its last check needs review";
  const age = reason.match(/is (\d+) days old/i)?.[1];
  if (age) return `its last check was ${age} days ago`;
  if (/inventory-changing activity/i.test(reason))
    return "it changed after the last check";
  if (/no accepted audit|no persisted verification/i.test(reason))
    return "it has not been checked yet";
  return reason;
}

/** Keeps older saved reports concise too, without rewriting their history. */
function eventSummary(
  event: TodayPlanAnalysisEventView,
  run: TodayPlanAnalysisRunView,
): string {
  if (event.stage === "COMPLETE" && run.result) return resultSummary(run);

  const reading = event.summary.match(
    /^Reading tomorrow’s enabled work for (.+) from the Google Sheet\.$/,
  );
  if (reading) return `Analyzing upcoming work for ${reading[1]}.`;

  const found = event.summary.match(/^Found (\d+) enabled work rows?\./);
  if (found)
    return `Found ${found[1]} work item${found[1] === "1" ? "" : "s"}. Finding the parts they need.`;

  const resolved = event.summary.match(
    /^Resolved (\d+) material requirements?\./,
  );
  if (resolved)
    return `Found ${resolved[1]} required part${resolved[1] === "1" ? "" : "s"}. Checking stock.`;

  const checking = event.summary.match(
    /^Retrieving the full bin (\S+) .* for (\S+) because (.+)\. It will return/,
  );
  if (checking)
    return `Checking ${checking[1]} for ${checking[2]} because ${plainCheckReason(checking[3])}.`;

  const checked = event.summary.match(
    /^Bin (\S+) was scanned and put back .* expected (\d+), observed (\d+)(?: at (\d+)% confidence)?\. Inventory was left unchanged\.$/,
  );
  if (checked) {
    return checked[2] === checked[3]
      ? "The bin was checked and returned. The count matched, but the photo needs another check. Stock was unchanged."
      : `The bin was checked and returned. Recorded: ${checked[2]}; verified: ${checked[3]}. Stock was unchanged.`;
  }

  return event.stage === "CHECKING_EVIDENCE"
    ? event.summary.replace(/^B\d+-\d{2}\b/, "The bin")
    : event.summary;
}

/** Persistent transcript card for the manually triggered, no-HITL plan diagnosis. */
export function TodayPlanAnalysisCard({
  run,
}: {
  run: TodayPlanAnalysisRunView;
}) {
  const running = run.status === "QUEUED" || run.status === "RUNNING";
  const latestEvents = run.events.slice(-6);
  const selectedBins = run.result?.selectedBins ?? [];
  const shortages = run.result?.shortages ?? [];
  const checksNeeded = neededChecks(run);
  // Older completed reports predate persisted skip reasons. In analysis mode,
  // a selected bin that was not audited could only have been selected from
  // trusted evidence, so preserve that useful explanation after deployment.
  const auditedBins = new Set(run.result?.auditedBinCodes ?? []);
  const scanSkips =
    run.result?.scanSkips ??
    selectedBins
      .filter((bin) => !auditedBins.has(bin.binCode))
      .map((bin) => ({
        sku: bin.sku,
        binCode: bin.binCode,
        lastVerifiedAt: null,
        reason: "trusted verification was reused",
      }));

  return (
    <section className="animate-fade-up overflow-hidden rounded-xl border border-accent-soft/50 bg-accent-tint/30">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
            Upcoming work plan
          </p>
          <p className="mt-1 text-xs text-ink-muted">{run.workDate}</p>
        </div>
        <StatusChip status={statusPresentation(run)} />
      </header>

      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          {running && (
            <span
              className="h-2 w-2 animate-glow-pulse rounded-full bg-accent"
              aria-hidden="true"
            />
          )}
          <p className="text-sm font-medium text-ink">
            {STAGE_LABELS[run.stage]}
          </p>
        </div>

        {run.rows.length > 0 && (
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Upcoming work · {run.rowsFound} item
              {run.rowsFound === 1 ? "" : "s"}
            </p>
            <div className="mt-2 space-y-1.5">
              {run.rows.slice(0, 4).map((row) => (
                <div
                  key={row.planId}
                  className="rounded-lg border border-line-soft bg-bg/40 px-3 py-2"
                >
                  <p className="truncate text-xs font-medium text-ink">
                    Upcoming{" "}
                    {assemblyNameFrom(
                      row.buildTask.trim() ||
                        row.project.trim() ||
                        "planned work",
                    )}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-muted">
                    {(row.priority || "Normal")
                      .replaceAll("_", " ")
                      .toLowerCase()
                      .replace(/^./, (letter) => letter.toUpperCase())}{" "}
                    priority
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {run.requirements.length > 0 && (
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Parts needed
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {run.requirements.map((requirement, index) => (
                <div
                  key={`${requirement.sku}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-bg/40 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-xs text-ink">
                    {materialName(requirement)}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-accent">
                    Needs {requirement.quantity}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {latestEvents.length > 0 && (
          <ol
            className="space-y-2 border-l border-line pl-3"
            aria-label="RackHand analysis progress"
          >
            {latestEvents.map((event, index) => {
              const latest = index === latestEvents.length - 1;
              const decision = auditDecisionDetails(event, run);
              if (decision) {
                const requirement = run.requirements.find(
                  (item) => item.sku === decision.sku,
                );
                return (
                  <li
                    key={event.id}
                    className="rounded-lg border border-line-soft bg-bg/50 p-3 text-ink"
                  >
                    <p className="text-xs font-semibold">
                      Upcoming {assemblyName(run)}
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Needs {requirement?.quantity ?? "—"}{" "}
                      {materialName(requirement)}
                    </p>
                    <p className="mt-2 text-xs text-ink">
                      Recorded: {decision.recordedQuantity ?? "—"}
                    </p>
                    <p className="mt-1 text-xs text-ink">
                      Last verified: {decision.lastVerified}
                    </p>
                    <p className="mt-2 text-xs font-medium text-accent">
                      RackHand chose to verify this bin
                    </p>
                  </li>
                );
              }
              return (
                <li
                  key={event.id}
                  className={latest ? "text-ink" : "text-ink-muted"}
                >
                  <p className="text-xs leading-relaxed">
                    {eventSummary(event, run)}
                  </p>
                </li>
              );
            })}
          </ol>
        )}

        {run.result && (
          <div className="space-y-3 rounded-lg border border-line bg-bg-elevated p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Final result
              </p>
              <StatusChip
                status={readinessPresentation(run.result.readiness)}
              />
            </div>
            <p className="text-xs leading-relaxed text-ink-muted">
              {resultSummary(run)}
            </p>

            {checksNeeded.length > 0 && (
              <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
                  Needs another check · {checksNeeded.length}
                </p>
                <div className="mt-2 space-y-2">
                  {checksNeeded.map((check) => {
                    const issue = check.issue;
                    const physical = run.result?.physicalCounts?.find((count) => count.binCode === check.binCode);
                    const requirement = run.requirements.find(
                      (item) => item.sku === (check.sku || issue?.sku),
                    );
                    return (
                      <div
                        key={`${check.binCode}-${issue?.reason ?? "verification-age"}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-ink">
                            {materialName(requirement)}
                          </p>
                          <p className="mt-0.5 text-[10px] text-ink-muted">
                            {check.binCode} · Recorded:{" "}
                            {check.recordedQuantity ?? "—"}
                          </p>
                          <p className="mt-0.5 text-[10px] text-danger">
                            Reason:{" "}
                            {verificationSelectionReason(
                              check.lastVerified,
                            )}
                          </p>
                          {(physical || issue) && (
                            <>
                              <p className="mt-0.5 text-[10px] text-ink-muted">
                                Physically found:{" "}
                                {physical?.observedQuantity ?? issue?.observedQuantity ?? "No clear count"}
                              </p>
                              <p className="mt-0.5 text-[10px] text-danger">
                                {physical?.inventoryUpdated ? "Stock updated" : "Stock unchanged"}
                              </p>
                              {physical?.scale.status === "VERIFIED" && (
                                <p className="mt-0.5 text-[10px] text-ink-muted">Scale count: {physical.scale.estimatedQuantity}</p>
                              )}
                              {physical?.scale.status === "UNAVAILABLE" && (
                                <p className="mt-0.5 text-[10px] text-ink-muted">Scale check unavailable</p>
                              )}
                              {physical?.scale.status === "MISMATCH" && (
                                <p className="mt-0.5 text-[10px] text-danger">Scale estimate: {physical.scale.estimatedQuantity} · Counts need review</p>
                              )}
                            </>
                          )}
                        </div>
                        <StatusChip
                          className="shrink-0"
                          status={{
                            label: "NEEDS ANOTHER CHECK",
                            symbol: "!",
                            tone: "danger",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {scanSkips.length > 0 && (
              <div className="rounded-lg border border-success/30 bg-success-soft p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-success">
                  Recent checks used · {scanSkips.length}
                </p>
                <div className="mt-2 space-y-2">
                  {scanSkips.map((skip) => {
                    const requirement = run.requirements.find(
                      (item) => item.sku === skip.sku,
                    );
                    const selected = selectedBins.find(
                      (bin) =>
                        bin.sku === skip.sku && bin.binCode === skip.binCode,
                    );
                    return (
                      <div
                        key={`${skip.sku}-${skip.binCode}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-ink">
                            {materialName(requirement)}
                          </p>
                          <p className="mt-0.5 text-[10px] text-ink-muted">
                            Recorded: {selected?.recordedQuantity ?? "—"} · Last
                            verified:{" "}
                            {relativeVerificationDate(skip.lastVerifiedAt, run)}
                          </p>
                        </div>
                        <StatusChip
                          className="shrink-0"
                          status={{
                            label: "RECENT CHECK USED",
                            symbol: "✓",
                            tone: "ok",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedBins.length > 0 && (
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-success">
                  Ready · {selectedBins.length} bin
                  {selectedBins.length === 1 ? "" : "s"}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {selectedBins.map((bin) => (
                    <div
                      key={`${bin.sku}-${bin.binCode}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-success/30 bg-success-soft px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-ink">
                          {materialName(
                            run.requirements.find(
                              (item) => item.sku === bin.sku,
                            ),
                          )}
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-muted">
                          Needs {bin.requiredQuantity} · Verified{" "}
                          {bin.recordedQuantity}
                        </p>
                      </div>
                      <StatusChip
                        status={{ label: "READY", symbol: "✓", tone: "ok" }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {shortages.length > 0 && (
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-danger">
                  Not ready · {shortages.length} part
                  {shortages.length === 1 ? "" : "s"}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {shortages.map((shortage) => (
                    <div
                      key={shortage.sku}
                      className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[10px] uppercase text-danger">
                          {assemblyName(run)} at risk
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-muted">
                          Needs {shortage.required} · {shortage.physicallyAvailable !== undefined ? "Physically found" : "Verified"}{" "}
                          {shortage.physicallyAvailable === null ? "Needs review" : shortage.physicallyAvailable ?? shortage.available}
                        </p>
                        <p className="mt-0.5 text-[10px] text-danger">
                          {shortage.physicallyAvailable === null
                            ? "Physical count needs another check"
                            : shortage.available >= shortage.required
                              ? "Count needs review before stock is ready"
                              : `Short by ${shortage.required - shortage.available} · Engineer attention needed`}
                        </p>
                      </div>
                      <StatusChip
                        status={{
                          label: "NOT READY",
                          symbol: "!",
                          tone: "danger",
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedBins.length === 0 && shortages.length === 0 && (
              <p className="text-xs text-ink-faint">No bins were selected.</p>
            )}
            {run.result.auditedBinCodes.length > 0 && (
              <p className="font-mono text-[9px] text-ink-faint">
                CHECKED AND RETURNED · {run.result.auditedBinCodes.join(", ")}
              </p>
            )}
          </div>
        )}

        {run.status === "FAILED" && run.errorMessage && (
          <p className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            {run.errorMessage}
          </p>
        )}

        <p className="font-mono text-[9px] leading-relaxed text-ink-faint">
          Bins are checked at the camera, then returned to the same shelf spot.
        </p>
      </div>
    </section>
  );
}
