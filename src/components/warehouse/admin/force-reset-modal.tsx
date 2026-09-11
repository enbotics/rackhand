"use client";

import { useState } from "react";
import type { BinView } from "@/lib/warehouse/dashboard-types";
import { Modal } from "../modal";
import { BUTTON_VARIANTS, ErrorNote } from "../ui";

interface ApiErrorBody {
  error: { code: string; message: string; issues?: string[] };
}

async function callJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    const err = body as ApiErrorBody;
    const message = err.error?.issues?.length
      ? `${err.error.message} (${err.error.issues.join(", ")})`
      : (err.error?.message ?? "Request failed.");
    throw new Error(message);
  }
  return body as T;
}

const STALE_BIN_STATUSES = new Set(["RESERVED", "CHECKED_OUT", "AUDITING"]);

interface ForceResetSummary {
  binsReset: Array<{ code: string; from: string; to: string }>;
  movementsFailed: number;
  putawayCapturesFailed: number;
  binAuditsFailed: number;
  auditCapturesFailed: number;
}

/**
 * A crashed/interrupted test run's only way back to a retestable state.
 * Deliberately its own modal, separate from Manage Bins — this reaches into
 * live Movement/capture/audit rows warehouse-wide, not just bin metadata, so
 * it gets its own explicit confirmation step rather than living as one more
 * section inside a routine admin screen.
 */
export function ForceResetModal({
  bins,
  onClose,
  onChanged,
}: {
  bins: BinView[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForceResetSummary | null>(null);

  const staleCount = bins.filter((bin) => STALE_BIN_STATUSES.has(bin.status)).length;

  return (
    <Modal title="Force reset stale bins" onClose={onClose} maxWidthClassName="max-w-md">
      <p className="text-xs leading-relaxed text-ink-muted">
        Reverts every bin stuck in RESERVED, CHECKED_OUT or AUDITING back to
        its prior status — for when a test run crashed mid-operation. Recorded
        inventory is never touched; only the bin&apos;s status, any dangling
        Movement/capture/audit row still pointing at it, and the gantry&apos;s
        own memory of that dead trip (so the rack view stops showing it as
        in transit).
      </p>

      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {staleCount} bin{staleCount === 1 ? "" : "s"} currently stale
      </p>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-lg border border-line bg-bg-elevated p-3 text-xs text-ink-muted">
          {result.binsReset.length === 0 ? (
            <p>No stale bins found.</p>
          ) : (
            <>
              <p className="font-semibold text-ink">
                Reset {result.binsReset.length} bin{result.binsReset.length === 1 ? "" : "s"}:
              </p>
              <p className="mt-1 font-mono text-[11px]">
                {result.binsReset.map((b) => `${b.code} ${b.from}→${b.to}`).join(", ")}
              </p>
              {(result.movementsFailed > 0 ||
                result.putawayCapturesFailed > 0 ||
                result.binAuditsFailed > 0 ||
                result.auditCapturesFailed > 0) && (
                <p className="mt-1">
                  Also failed {result.movementsFailed} movement(s),{" "}
                  {result.putawayCapturesFailed} putaway capture(s),{" "}
                  {result.binAuditsFailed} bin audit(s), {result.auditCapturesFailed}{" "}
                  audit capture(s) still pointing at them.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={busy}
              className={BUTTON_VARIANTS.secondary}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const summary = await callJson<ForceResetSummary>(
                    "/api/warehouse/admin/force-reset",
                    { method: "POST" },
                  );
                  setResult(summary);
                  setConfirming(false);
                  onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Reset failed.");
                } finally {
                  setBusy(false);
                }
              }}
              className={BUTTON_VARIANTS.danger}
            >
              Yes, force reset
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
              setResult(null);
              setError(null);
            }}
            className={BUTTON_VARIANTS.danger}
          >
            Force reset stale bins
          </button>
        )}
      </div>
    </Modal>
  );
}
