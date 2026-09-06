"use client";

import { useEffect, useState } from "react";
import type { Measurement, Shot } from "@/lib/shots-db";
import { setShotMeasurement } from "@/lib/shots-db";
import { measurementToScanResult } from "@/lib/warehouse/scan-result";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import type { CatalogMatchResult } from "@/lib/warehouse/catalog-match-types";
import { CloseIcon, DownloadIcon, RulerIcon, SparkleIcon, TrashIcon } from "@/components/icons";

function formatFull(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtMM(value: number) {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function Lightbox({
  shot,
  onClose,
  onDelete,
  onMeasured,
}: {
  shot: Shot;
  onClose: () => void;
  onDelete: (id: string) => void;
  onMeasured: (id: string, measurement: Measurement, scanResult?: ScanResult) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchState, setMatchState] = useState<
    { scanId: string; result?: CatalogMatchResult; error?: string } | null
  >(null);

  // A verdict belongs to the scan it was computed from. Tagging it with the
  // scanId and checking that during render means a different shot (or a
  // re-measure) simply stops showing it — no effect, no stale match.
  const activeMatch =
    matchState && matchState.scanId === shot.scanResult?.scanId ? matchState : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const measure = async () => {
    setMeasuring(true);
    setMeasureError(null);
    try {
      const res = await fetch("/api/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: shot.dataUrl,
          imageWidthPx: shot.width,
          imageHeightPx: shot.height,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error?.message ?? "Measurement failed.");
      }
      const measurement: Measurement = {
        name: body.name,
        description: body.description,
        lengthMM: body.lengthMM,
        widthMM: body.widthMM,
        heightMM: body.heightMM,
        angleDegrees: body.angleDegrees,
        dimensionConfidence: body.dimensionConfidence,
        calibrationRmsPixels: body.calibrationRmsPixels,
        measuredAt: Date.now(),
      };
      // The measurement itself is good at this point; ScanResult is a
      // separate contract on top of it, so a rejected conversion still keeps
      // (and shows) the measurement rather than failing the whole measure.
      const conversion = measurementToScanResult(measurement, { capturedAt: shot.createdAt });
      const scanResult = conversion.ok ? conversion.scanResult : undefined;
      if (!conversion.ok) {
        setMeasureError(
          `Measured, but no scan record was created — ${conversion.issues.join("; ")}.`,
        );
      }

      await setShotMeasurement(shot.id, measurement, scanResult);
      onMeasured(shot.id, measurement, scanResult);
    } catch (err) {
      setMeasureError(err instanceof Error ? err.message : "Measurement failed.");
    } finally {
      setMeasuring(false);
    }
  };

  /**
   * Developer view of Milestone 3's catalog matcher. Read-only: the endpoint
   * never registers a part or touches inventory, so this button is safe to
   * press repeatedly.
   */
  const matchCatalog = async () => {
    const scanResult = shot.scanResult;
    if (!scanResult) return;
    setMatching(true);
    setMatchState(null);
    try {
      const res = await fetch("/api/warehouse/catalog/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanResult }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "Catalog match failed.");
      setMatchState({ scanId: scanResult.scanId, result: body as CatalogMatchResult });
    } catch (err) {
      setMatchState({
        scanId: scanResult.scanId,
        error: err instanceof Error ? err.message : "Catalog match failed.",
      });
    } finally {
      setMatching(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in sm:p-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass animate-pop relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-line shadow-[0_40px_80px_-20px_rgba(0,0,0,0.7)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-ink-muted">
              {formatFull(shot.createdAt)} · {shot.width}×{shot.height}
            </p>
            {shot.deviceLabel && (
              <p className="truncate font-mono text-[10px] text-ink-faint">
                {shot.deviceLabel}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Everything between header and footer scrolls as one region, so a
            tall image + result panel can never push the action buttons (or
            the result itself) out of reach the way a split scroll area did. */}
        <div className="flex-1 overflow-y-auto">
          <div className="bg-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={shot.dataUrl}
              alt={`Shot captured ${formatFull(shot.createdAt)}`}
              className="mx-auto max-h-[40vh] w-auto"
            />
          </div>

          {shot.measurement && (
            <div className="animate-fade-in border-t border-line-soft bg-surface/60 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-ink">{shot.measurement.name}</p>
                  {shot.measurement.description && (
                    <p className="mt-0.5 text-xs text-ink-muted">{shot.measurement.description}</p>
                  )}
                </div>
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                  {Math.round(shot.measurement.dimensionConfidence * 100)}% fit
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2.5">
                <div className="rounded-2xl border border-line bg-bg-elevated px-3 py-3 text-center">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">Length</p>
                  <p className="mt-1 font-mono text-2xl font-semibold text-accent">
                    {fmtMM(shot.measurement.lengthMM)}
                    <span className="ml-1 text-sm text-ink-faint">mm</span>
                  </p>
                </div>
                <div className="rounded-2xl border border-line bg-bg-elevated px-3 py-3 text-center">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">Width</p>
                  <p className="mt-1 font-mono text-2xl font-semibold text-accent">
                    {fmtMM(shot.measurement.widthMM)}
                    <span className="ml-1 text-sm text-ink-faint">mm</span>
                  </p>
                </div>
                <div className="rounded-2xl border border-line bg-bg-elevated px-3 py-3 text-center">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">Height</p>
                  <p
                    className={`mt-1 font-mono text-2xl font-semibold ${
                      shot.measurement.heightMM != null ? "text-accent" : "text-ink-faint"
                    }`}
                  >
                    {shot.measurement.heightMM != null ? (
                      <>
                        {fmtMM(shot.measurement.heightMM)}
                        <span className="ml-1 text-sm text-ink-faint">mm</span>
                      </>
                    ) : (
                      <span className="text-base">unknown</span>
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-ink-faint">
                <span>rotation ∠ {shot.measurement.angleDegrees.toFixed(0)}°</span>
                <span>mat calibration {shot.measurement.calibrationRmsPixels.toFixed(1)}px RMS</span>
              </div>

              {shot.scanResult && (
                <p className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                  {shot.scanResult.scanId}
                </p>
              )}
            </div>
          )}

          {measureError && (
            <div className="animate-fade-in border-t border-line-soft bg-danger-soft px-4 py-2.5">
              <p className="text-xs text-danger">{measureError}</p>
            </div>
          )}

          {activeMatch?.result && (
            <div className="animate-fade-in border-t border-line-soft bg-surface/60 px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                Catalog match
              </p>
              {activeMatch.result.status === "MATCHED" ? (
                <>
                  <div className="mt-1 flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-semibold text-ink">
                      <span className="font-mono text-accent">{activeMatch.result.matchedPart.sku}</span>
                      <span className="ml-2 font-normal text-ink-muted">
                        {activeMatch.result.matchedPart.canonicalName}
                      </span>
                    </p>
                    <span className="shrink-0 font-mono text-sm font-semibold text-accent">
                      {Math.round(activeMatch.result.confidence * 100)}%
                    </span>
                  </div>
                  {activeMatch.result.alternatives.length > 0 && (
                    <p className="mt-1 font-mono text-[10px] text-ink-faint">
                      alternative{activeMatch.result.alternatives.length > 1 ? "s" : ""}:{" "}
                      {activeMatch.result.alternatives
                        .map((a) => `${a.sku} — ${Math.round(a.confidence * 100)}%`)
                        .join(", ")}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    {activeMatch.result.status === "AMBIGUOUS"
                      ? "Ambiguous — needs review"
                      : "No catalog match"}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">{activeMatch.result.reason}</p>
                  {activeMatch.result.candidates.length > 0 && (
                    <p className="mt-1 font-mono text-[10px] text-ink-faint">
                      {activeMatch.result.candidates
                        .map((c) => `${c.sku} — ${Math.round(c.confidence * 100)}%`)
                        .join(", ")}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {activeMatch?.error && (
            <div className="animate-fade-in border-t border-line-soft bg-danger-soft px-4 py-2.5">
              <p className="text-xs text-danger">{activeMatch.error}</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line-soft px-4 py-3">
          {confirming ? (
            <div className="flex items-center gap-2 animate-fade-in">
              <span className="text-xs text-ink-muted">Delete this shot?</span>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => onDelete(shot.id)}
                className="rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-bg transition-colors hover:opacity-90"
              >
                Delete
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => setConfirming(true)}
                className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Delete
              </button>
              <button
                onClick={measure}
                disabled={measuring}
                className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-accent-soft hover:text-accent disabled:pointer-events-none disabled:opacity-50"
              >
                <SparkleIcon className={`h-3.5 w-3.5 ${measuring ? "animate-glow-pulse" : ""}`} />
                {measuring ? "Measuring…" : shot.measurement ? "Re-measure" : "Measure"}
              </button>
              {shot.scanResult && (
                <button
                  onClick={matchCatalog}
                  disabled={matching}
                  className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-xs font-medium text-ink-muted transition-colors hover:border-accent-soft hover:text-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <RulerIcon className="h-3.5 w-3.5" />
                  {matching ? "Matching…" : "Match catalog"}
                </button>
              )}
              <a
                href={shot.dataUrl}
                download={`scan-${shot.id}.jpg`}
                className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-accent to-accent-2 px-3.5 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90"
              >
                <DownloadIcon className="h-3.5 w-3.5" />
                Download
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
