"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTurn } from "./state";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Panel } from "./ui";

/**
 * The Warehouse Agent conversation.
 *
 * Replies are revealed progressively after POST /api/agent returns. This is a
 * presentation animation, not fake transport streaming: the busy state stays
 * visible until the complete, server-authored answer arrives. Tool chips are
 * names only—never arguments, model reasoning, or fabricated progress.
 */
const SUGGESTIONS = [
  "Which bins are available?",
  "Is the gantry ready?",
  "Store this part.",
  "Bring me BRG-6204.",
];

const TOOL_LABELS: Record<string, string> = {
  get_gantry_status: "Gantry status",
  search_catalog: "Catalog search",
  get_part: "Part record",
  search_inventory: "Inventory",
  get_bin_status: "Bin status",
  list_available_bins: "Available slots",
  match_catalog: "Catalog match",
  request_guided_putaway: "Guided putaway",
  get_guided_putaway_status: "Putaway status",
  execute_retrieval: "Retrieval workflow",
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

function AgentReplyText({
  text,
  animate,
  onProgress,
}: {
  text: string;
  animate: boolean;
  onProgress: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [animateThisMessage] = useState(animate);
  const [visibleLength, setVisibleLength] = useState(() =>
    animate && !reducedMotion ? 0 : text.length,
  );
  const [complete, setComplete] = useState(
    () => !animate || reducedMotion || text.length === 0,
  );
  const revealing = animateThisMessage && !reducedMotion && text.length > 0;
  const renderedLength = revealing ? visibleLength : text.length;
  const renderedComplete = revealing ? complete : true;

  useEffect(() => {
    if (!animateThisMessage || reducedMotion || text.length === 0) return;

    const durationMs = Math.min(2_600, Math.max(650, text.length * 13));
    const startedAt = performance.now();
    let frame = 0;
    const reveal = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setVisibleLength(Math.max(1, Math.round(text.length * eased)));
      onProgress();
      if (progress < 1) {
        frame = requestAnimationFrame(reveal);
      } else {
        setComplete(true);
      }
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [animateThisMessage, onProgress, reducedMotion, text]);

  return (
    <>
      <p aria-label={text} className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
        <span aria-hidden={animateThisMessage && !reducedMotion ? "true" : undefined}>
          {text.slice(0, renderedLength)}
        </span>
        {!renderedComplete && (
          <span
            className="agent-typing-cursor ml-0.5 inline-block h-[1em] w-px translate-y-[2px] bg-accent"
            aria-hidden="true"
          />
        )}
      </p>
      {!renderedComplete && (
        <span className="sr-only" aria-live="polite">
          Agent response received.
        </span>
      )}
    </>
  );
}

function ToolChips({ tools }: { tools: string[] }) {
  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5 animate-fade-up"
      aria-label="Warehouse systems used"
    >
      {tools.map((toolName, index) => (
        <span
          key={`${toolName}-${index}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent-soft/40 bg-accent-tint px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-accent"
        >
          <span className="h-1 w-1 rounded-full bg-accent" aria-hidden="true" />
          {TOOL_LABELS[toolName] ?? toolName.replaceAll("_", " ")}
        </span>
      ))}
    </div>
  );
}

function ConversationTurn({
  turn,
  animate,
  onProgress,
}: {
  turn: AgentTurn;
  animate: boolean;
  onProgress: () => void;
}) {
  const operator = turn.role === "operator";
  const system = turn.role === "system";

  if (system) {
    return (
      <div className="animate-fade-up rounded-lg border border-warn/30 bg-warn-soft px-3 py-2">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-warn">System</p>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <div className={`flex animate-fade-up gap-2.5 ${operator ? "justify-end" : "justify-start"}`}>
      {!operator && (
        <div
          className="agent-orb mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent-soft/50 bg-accent-tint font-mono text-[10px] font-semibold text-accent"
          aria-hidden="true"
        >
          W
        </div>
      )}
      <div className={`max-w-[88%] ${operator ? "text-right" : "text-left"}`}>
        <p
          className={`font-mono text-[9px] uppercase tracking-[0.14em] ${
            operator ? "text-ink-faint" : "text-accent"
          }`}
        >
          {operator ? "You" : "Warehouse agent"}
        </p>
        <div
          className={`mt-1 rounded-2xl border px-3 py-2.5 ${
            operator
              ? "rounded-tr-sm border-line bg-bg-elevated"
              : "rounded-tl-sm border-accent-soft/30 bg-[linear-gradient(135deg,rgba(91,157,217,0.09),rgba(20,24,30,0.9))] shadow-[0_10px_30px_-24px_rgba(91,157,217,0.8)]"
          }`}
        >
          {operator ? (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{turn.text}</p>
          ) : (
            <AgentReplyText text={turn.text} animate={animate} onProgress={onProgress} />
          )}
        </div>
        {!operator && turn.tools && turn.tools.length > 0 && <ToolChips tools={turn.tools} />}
      </div>
      {operator && (
        <div
          className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-hover font-mono text-[10px] text-ink-muted"
          aria-hidden="true"
        >
          Y
        </div>
      )}
    </div>
  );
}

function AgentWorking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, []);
  const label =
    elapsed < 1_500 ? "Contacting warehouse agent" : "Waiting for verified response";

  return (
    <div
      className="flex animate-fade-up items-start gap-2.5"
      role="status"
      aria-live="polite"
    >
      <div
        className="agent-orb animate-breathe flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent-soft/60 bg-accent-tint font-mono text-[10px] font-semibold text-accent"
        aria-hidden="true"
      >
        W
      </div>
      <div className="rounded-2xl rounded-tl-sm border border-accent-soft/30 bg-accent-tint px-3 py-2.5">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent">
          Warehouse agent
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-xs text-ink-muted">{label}</span>
          <span className="flex gap-1" aria-hidden="true">
            <span className="agent-thinking-dot h-1 w-1 rounded-full bg-accent" />
            <span className="agent-thinking-dot h-1 w-1 rounded-full bg-accent [animation-delay:160ms]" />
            <span className="agent-thinking-dot h-1 w-1 rounded-full bg-accent [animation-delay:320ms]" />
          </span>
        </div>
      </div>
    </div>
  );
}

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
  unavailable: boolean;
  error: string | null;
  scanAttached: boolean;
  identityAttached: boolean;
  onSend: (message: string) => void;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [turnsPresentAtMount] = useState(() => new Set(turns.map((turn) => turn.id)));
  const transcriptRef = useRef<HTMLDivElement>(null);

  const scrollToLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const distanceFromBottom =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    if (distanceFromBottom < 120) transcript.scrollTop = transcript.scrollHeight;
  }, []);

  useEffect(() => scrollToLatest(), [busy, scrollToLatest, turns.length]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setDraft("");
    onSend(trimmed);
  };

  return (
    <Panel
      title="Warehouse agent"
      className="min-h-[440px] overflow-hidden"
      meta={
        scanAttached ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(91,157,217,0.8)]" />
            {identityAttached ? "scan + identity" : "scan attached"}
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

        <div
          ref={transcriptRef}
          className="min-h-[230px] flex-1 space-y-4 overflow-y-auto pr-1 scroll-smooth"
        >
          {turns.length === 0 && !busy ? (
            <EmptyState>
              Ask about inventory, bins, or the gantry—or request a guided putaway.
              <br />
              Putaway continues in the guided dialog; retrieval pauses for approval.
            </EmptyState>
          ) : (
            turns.map((turn) => (
              <ConversationTurn
                key={turn.id}
                turn={turn}
                animate={turn.role === "agent" && !turnsPresentAtMount.has(turn.id)}
                onProgress={scrollToLatest}
              />
            ))
          )}

          {busy && <AgentWorking />}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => send(suggestion)}
              disabled={busy}
              className="rounded-full border border-line bg-bg-elevated px-2.5 py-1 font-mono text-[9px] text-ink-faint transition-all hover:-translate-y-0.5 hover:border-accent-soft hover:bg-accent-tint hover:text-accent disabled:pointer-events-none disabled:opacity-40"
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
          className="flex items-center gap-2 rounded-xl border border-line bg-bg-elevated p-1.5 transition-colors focus-within:border-accent-soft"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the warehouse…"
            aria-label="Message the warehouse agent"
            disabled={busy}
            className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || draft.trim() === ""}
            className={BUTTON_VARIANTS.primary}
          >
            Send
            <span aria-hidden="true">↗</span>
          </button>
        </form>
      </div>
    </Panel>
  );
}
