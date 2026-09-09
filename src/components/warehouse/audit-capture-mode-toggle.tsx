"use client";

import { useEffect, useState } from "react";

type AuditCaptureMode = "PROD" | "SIMULATION";

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

/**
 * Live switch for how the inventory auditor gets its photo — see
 * lib/warehouse/audit-capture-mode.ts. Used to be AUDIT_CAPTURE_MODE in
 * .env, which meant flipping it needed a server restart; this calls the
 * same runtime setting the server already reads on every audit.
 */
export function AuditCaptureModeToggle() {
  const [mode, setMode] = useState<AuditCaptureMode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/warehouse/audit-capture-mode")
      .then((response) => response.json())
      .then((data: { mode?: AuditCaptureMode }) => {
        if (!cancelled && data.mode) setMode(data.mode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === null) return null;
  const simulation = mode === "SIMULATION";

  async function flip() {
    const next: AuditCaptureMode = simulation ? "PROD" : "SIMULATION";
    setBusy(true);
    setMode(next);
    const { ok, data } = await postJson("/api/warehouse/audit-capture-mode", { mode: next });
    setBusy(false);
    if (!ok) setMode(simulation ? "SIMULATION" : "PROD");
    else if (data.mode) setMode(data.mode as AuditCaptureMode);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={simulation}
      aria-label="Audit capture mode"
      disabled={busy}
      onClick={() => void flip()}
      title="How the inventory auditor gets its photo: a Raspberry Pi capture (PROD) or a sampled demo photo (SIMULATION). Click to switch."
      className="group flex cursor-pointer items-center gap-2 rounded-full border border-line bg-bg-elevated py-1 pl-2.5 pr-1.5 font-mono text-[9px] uppercase tracking-wider transition-colors hover:border-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className={simulation ? "text-amber-200" : "text-accent"}>
        {simulation ? "Simulation" : "Prod"}
      </span>
      {/* The track + thumb is what actually reads as "toggle" at a glance — a
          colored pill alone looks like a status badge, not something clickable. */}
      <span
        aria-hidden="true"
        className={`relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors duration-200 group-hover:brightness-110 ${
          simulation ? "bg-amber-400/80" : "bg-accent/80"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
            simulation ? "translate-x-[17px]" : "translate-x-[2px]"
          }`}
        />
      </span>
    </button>
  );
}
