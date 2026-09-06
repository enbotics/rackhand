"use client";

import { useState } from "react";
import type { AgentTurn } from "./state";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Panel } from "./ui";

/**
 * The Warehouse Agent conversation.
 *
 * Every reply comes from POST /api/agent, which runs the one Strands agent
 * server-side. No response is composed, cached or faked here, and no model
 * credential exists in this bundle — the browser only ever sees the visible
 * answer and the list of tool names that were called.
 *
 * The tool line is an operational trace, not observability: names only, no
 * arguments, no timings, no reasoning. Milestone 12 owns the real thing.
 *
 * If the model is unreachable this panel says so and stops there. The camera,
 * the warehouse map, inventory and movement history do not depend on it.
 */
const SUGGESTIONS = [
  "Which bins are available?",
  "Is the gantry ready?",
  "Store this part.",
  "Bring me BRG-6204.",
];

export function AgentPanel({
  turns,
  busy,
  unavailable,
  error,
  scanAttached,
  identityAttached,
  onSend,
  onRetry,
}: {
  turns: AgentTurn[];
  busy: boolean;
  /** The model itself could not be reached — a different thing from a failed request. */
  unavailable: boolean;
  error: string | null;
  scanAttached: boolean;
  identityAttached: boolean;
  onSend: (message: string) => void;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState("");

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setDraft("");
    onSend(trimmed);
  };

  return (
    <Panel
      title="Warehouse agent"
      className="min-h-[420px]"
      meta={
        scanAttached ? (
          <span className="font-mono text-[10px] text-accent">
            {identityAttached ? "scan + confirmed identity attached" : "current scan attached"}
          </span>
        ) : undefined
      }
    >
      <div className="flex h-full flex-col gap-3">
        {unavailable ? (
          <ErrorNote onRetry={onRetry} retryLabel="Try again">
            Warehouse agent unavailable — the language model could not be reached. Everything else
            on this screen still works, and no warehouse state was changed.
          </ErrorNote>
        ) : (
          error && <ErrorNote onRetry={onRetry}>{error}</ErrorNote>
        )}

        <div className="min-h-[220px] flex-1 space-y-3 overflow-y-auto pr-1">
          {turns.length === 0 && !busy ? (
            <EmptyState>
              Ask the warehouse a question, or tell it to store or bring a part.
              <br />
              Anything that moves stock will stop for your approval first.
            </EmptyState>
          ) : (
            turns.map((turn) => (
              <div key={turn.id}>
                <p
                  className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
                    turn.role === "operator"
                      ? "text-ink-faint"
                      : turn.role === "system"
                        ? "text-warn"
                        : "text-accent"
                  }`}
                >
                  {turn.role === "operator" ? "You" : turn.role === "system" ? "System" : "Agent"}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink">
                  {turn.text}
                </p>
                {turn.tools && turn.tools.length > 0 && (
                  <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
                    Used warehouse data — {turn.tools.join(", ")}
                  </p>
                )}
              </div>
            ))
          )}

          {busy && (
            <div className="flex items-center gap-2.5">
              <div className="animate-spin-slow h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line border-t-accent" />
              <p className="font-mono text-[11px] text-ink-muted">Thinking…</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => send(suggestion)}
              disabled={busy}
              className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-ink-faint transition-colors hover:border-accent-soft hover:text-accent disabled:pointer-events-none disabled:opacity-40"
            >
              {suggestion}
            </button>
          ))}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the warehouse…"
            aria-label="Message the warehouse agent"
            disabled={busy}
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg-elevated px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-50"
          />
          <button type="submit" disabled={busy} className={BUTTON_VARIANTS.primary}>
            Send
          </button>
        </form>
      </div>
    </Panel>
  );
}
