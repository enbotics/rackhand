"use client";

import {
  IDENTITY_PROVENANCE,
  SCAN_IDENTITY_PRESENTATION,
  formatMM,
  formatPercent,
  type ScanIdentityStatus,
} from "@/lib/warehouse/dashboard-presentation";
import type { ConfirmedIdentity, ScanState } from "./state";
import { EmptyState, Metric, Panel, StatusChip } from "./ui";

/**
 * What the camera just saw, and what the warehouse thinks it is.
 *
 * Two separate questions, kept visually separate: the MEASUREMENT (what was on
 * the mat, in millimetres) and the IDENTITY (which catalog part that is). The
 * second is never presented as certain when it is not — AMBIGUOUS, NO MATCH
 * and INVALID SCAN each get their own state, with a word and a symbol as well
 * as a colour, and none of them shows anything resembling a success.
 *
 * Every value comes from the server: /api/measure for the measurement,
 * /api/warehouse/catalog/match for the identity. Nothing is computed here.
 */
export function CurrentScanPanel({
  state,
  identity,
  confirmed,
}: {
  state: ScanState;
  identity: ScanIdentityStatus | null;
  confirmed: ConfirmedIdentity | null;
}) {
  const { phase, scan, failure } = state;

  return (
    <Panel
      title="Current scan"
      meta={
        identity ? <StatusChip status={SCAN_IDENTITY_PRESENTATION[identity]} /> : undefined
      }
    >
      {phase === "EMPTY" && (
        <EmptyState>
          No current scan.
          <br />
          Place one part on the calibration mat and press “Scan Part”.
        </EmptyState>
      )}

      {phase === "MEASURING" && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-4 py-6">
          <div className="animate-spin-slow h-4 w-4 shrink-0 rounded-full border-2 border-line border-t-accent" />
          <p className="text-xs text-ink-muted">
            Detecting the calibration mat and measuring the part…
          </p>
        </div>
      )}

      {phase === "FAILED" && failure && (
        <div className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
            × Scan failed
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink">{failure.title}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{failure.guidance}</p>
        </div>
      )}

      {(phase === "READY" || phase === "MATCHING") && scan?.measurement && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold text-ink">{scan.measurement.name}</p>
            {scan.measurement.description && (
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {scan.measurement.description}
              </p>
            )}
            <p className="mt-1 font-mono text-[10px] text-ink-faint">
              Detected by vision — not a catalog identity.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric label="Length" value={formatMM(scan.measurement.lengthMM)} unit="mm" tone="accent" />
            <Metric label="Width" value={formatMM(scan.measurement.widthMM)} unit="mm" tone="accent" />
            <Metric
              label="Height"
              value={formatMM(scan.measurement.heightMM)}
              unit={scan.measurement.heightMM === null ? undefined : "mm"}
              tone={scan.measurement.heightMM === null ? "muted" : "accent"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px] text-ink-faint">
            <span>
              Dimension confidence{" "}
              <span className="text-ink-muted">
                {formatPercent(scan.measurement.dimensionConfidence)}
              </span>
            </span>
            <span>
              Calibration RMS{" "}
              <span className="text-ink-muted">
                {scan.measurement.calibrationRmsPixels.toFixed(1)} px
              </span>
            </span>
            <span>∠ {scan.measurement.angleDegrees.toFixed(0)}°</span>
          </div>

          <div className="border-t border-line-soft pt-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              Catalog
            </p>

            {phase === "MATCHING" && (
              <p className="mt-2 text-xs text-ink-muted">
                Comparing the measurement against the parts catalog…
              </p>
            )}

            {phase === "READY" && identity === null && (
              <p className="mt-2 text-xs text-ink-muted">Not compared against the catalog yet.</p>
            )}

            {identity === "INVALID_SCAN" && (
              <div className="mt-2">
                <p className="text-xs leading-relaxed text-ink-muted">
                  {IDENTITY_PROVENANCE.INVALID_SCAN} Scan the part again — a person cannot override
                  a measurement the pipeline rejected.
                </p>
                {scan.issues.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 font-mono text-[10px] text-ink-faint">
                    {scan.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {identity === "HUMAN_CONFIRMED" && confirmed && (
              <div className="mt-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold">
                    <span className="font-mono text-accent">{confirmed.sku}</span>
                    <span className="ml-2 font-normal text-ink-muted">
                      {confirmed.canonicalName}
                    </span>
                  </p>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{IDENTITY_PROVENANCE.HUMAN_CONFIRMED}</p>
                <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                  The matcher still reports AMBIGUOUS for this scan.
                </p>
              </div>
            )}

            {identity === "MATCHED" && scan.match?.status === "MATCHED" && (
              <div className="mt-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold">
                    <span className="font-mono text-accent">{scan.match.matchedPart.sku}</span>
                    <span className="ml-2 font-normal text-ink-muted">
                      {scan.match.matchedPart.canonicalName}
                    </span>
                  </p>
                  <span className="shrink-0 font-mono text-sm font-semibold text-success">
                    {formatPercent(scan.match.confidence)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{IDENTITY_PROVENANCE.MATCHED}</p>
                {scan.match.alternatives.length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-ink-faint">
                    Runners-up:{" "}
                    {scan.match.alternatives
                      .map((alt) => `${alt.sku} ${formatPercent(alt.confidence)}`)
                      .join(", ")}
                  </p>
                )}
              </div>
            )}

            {identity === "AMBIGUOUS" && scan.match?.status === "AMBIGUOUS" && (
              <div className="mt-2">
                <p className="text-xs leading-relaxed text-ink">{scan.match.reason}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {IDENTITY_PROVENANCE.AMBIGUOUS} An operator must decide before this part can be
                  put away.
                </p>
              </div>
            )}

            {identity === "NO_MATCH" && scan.match?.status === "NO_MATCH" && (
              <div className="mt-2">
                <p className="text-xs leading-relaxed text-ink">{scan.match.reason}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {IDENTITY_PROVENANCE.NO_MATCH} Putaway is not available for this scan, and
                  registering a new part is not part of this system.
                </p>
              </div>
            )}

            {scan.matchError && (
              <p className="mt-2 text-xs text-danger">
                The catalog matcher could not be reached. The measurement above is unaffected.
              </p>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
