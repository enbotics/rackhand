"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GantryStatus } from "@/lib/gantry/types";
import type { WarehouseGraphResult } from "@/lib/warehouse/graphs/workflow-types";
import type {
  InventoryAuditView,
  MaterialRequirementView,
  MaterialsPlanCheckView,
  MovementRowView,
} from "@/lib/warehouse/dashboard-types";
import type {
  AgentTurn,
  ApprovalOutcome,
  ConfirmedIdentity,
  PendingApprovalView,
  PendingIdentification,
} from "./state";
import { ApprovalCard } from "./approval-card";
import { CatalogResolutionCard } from "./catalog-resolution-card";
import { WorkflowPanel } from "./workflow-panel";
import { InventoryAuditPanel } from "./inventory-audit-panel";
import { MaterialsPlanPipelineCard } from "./materials-plan-pipeline-card";
import { materialsCheckRunning } from "./materials-check-progress-card";
import { usePrefersReducedMotion } from "./use-reduced-motion";
import { BUTTON_VARIANTS, EmptyState, ErrorNote, Panel } from "./ui";

/**
 * The Warehouse Agent conversation.
 *
 * Replies are revealed progressively after POST /api/agent returns. This is a
 * presentation animation, not fake transport streaming: the busy state stays
 * visible until the complete, server-authored answer arrives. Tool chips are
 * names only—never arguments, model reasoning, or fabricated progress.
 *
 * EVERY agent-driven state lives INSIDE this same scrollable transcript, not
 * beside it — identification choices, HITL approval, workflow/gantry
 * progress and audit results are the trailing "current state" cards below
 * the message list, reusing ApprovalCard/CatalogResolutionCard/WorkflowPanel/
 * InventoryAuditPanel exactly as they already are. Moving WHERE they mount
 * was the whole refactor; none of their internal logic changed, so approval
 * decisions still only ever send `{approvalId, decision}` to the server.
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
  execute_putaway: "Execute putaway",
  execute_retrieval: "Retrieval workflow",
  inventory_auditor: "Inventory auditor agent",
  execute_inventory_audit: "Physical inventory audit",
  materials_planner: "Materials planner agent",
  verify_materials_availability: "Stock check started",
};

/**
 * How long a settled trailing card stays before retiring itself, and how long
 * its fade takes. Only the trailing "current state" card is ever dismissed —
 * operator and agent messages are conversation history and are never removed.
 */
const CARD_DISMISS_AFTER_MS = 8_000;
const CARD_FADE_MS = 450;

/** Approval outcomes that are answers. EXECUTING and DECIDING are still in flight. */
const SETTLED_OUTCOMES = new Set(["SETTLED", "CANCELLED", "EXPIRED", "REJECTED"]);

/**
 * A trailing "current state" card that clears itself once it is finished.
 *
 * WHY: a settled approval, a finished workflow and a completed audit are
 * answers, not questions — leaving them pinned under the conversation turns
 * the chat into a graveyard of stale panels, and the operator's next message
 * arrives below three cards about the last one. Eight seconds is long enough
 * to read the outcome, after which the transcript is just the transcript.
 *
 * WHAT IT NEVER DOES: dismiss anything still live, and it never auto-dismisses
 * a FAILURE — for ANY of the three cards below (approval, workflow, audit),
 * not just one of them. `settled` is false for PENDING/RUNNING/EXECUTING
 * states, a BLOCKED workflow (waiting on a person), and — deliberately —
 * a terminal FAILED status: that can mean physical reconciliation is
 * required, and silently wiping it after 8 seconds could hide the one thing
 * an operator still needed to see. A failed card instead gets `dismissible`,
 * a manual close, so it never auto-hides but also never sits there forever
 * with no way to clear it once it's been read. Nothing here touches session
 * state either way — this is presentation only, the underlying
 * approval/workflow/audit records are untouched and re-appear under a new
 * `cardKey` the moment they change.
 */
function SettlingCard({
  cardKey,
  settled,
  dismissible = false,
  onDismissed,
  children,
}: {
  /** Identity of what is being shown. A change means "this is a new thing", and restarts the clock. */
  cardKey: string;
  settled: boolean;
  /** Offers a manual "Dismiss" control. For a terminal card that chose not to auto-dismiss (a failure) — never for one still in progress. */
  dismissible?: boolean;
  onDismissed: () => void;
  children: React.ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [phase, setPhase] = useState<"visible" | "leaving" | "dismissed">("visible");
  const [seenKey, setSeenKey] = useState(cardKey);

  // Adjusted during render (React's own pattern for resetting state when an
  // external value changes) rather than in an effect, which would show the
  // previous card's dismissed state for a frame before correcting itself.
  if (cardKey !== seenKey) {
    setSeenKey(cardKey);
    setPhase("visible");
  }

  useEffect(() => {
    if (!settled || phase !== "visible") return;
    const timer = window.setTimeout(
      // A reduced-motion operator still gets the dismissal, just not the fade.
      () => setPhase(reducedMotion ? "dismissed" : "leaving"),
      CARD_DISMISS_AFTER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion, settled]);

  useEffect(() => {
    if (phase !== "leaving") return;
    // Timed rather than driven by animationend: the reduced-motion rule in
    // globals.css sets `animation: none`, which fires no event at all.
    const timer = window.setTimeout(() => setPhase("dismissed"), CARD_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "dismissed") onDismissed();
  }, [onDismissed, phase]);

  if (phase === "dismissed") return null;

  return (
    <div className={phase === "leaving" ? "animate-fade-out" : "animate-fade-up"}>
      {children}
      {dismissible && phase === "visible" && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setPhase(reducedMotion ? "dismissed" : "leaving")}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint transition-colors hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
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

/**
 * `liveToolName` is a FACT, not a guess: it is polled from a server-side
 * store written the instant the SDK's own BeforeToolCallEvent fires for the
 * tool the model is actually about to run (see live-status-store.ts and
 * use-agent-status.ts). This replaced an earlier client-side heuristic that
 * pattern-matched the operator's own message text against a hardcoded phrase
 * list before the server had done anything — a guess that reliably missed
 * any wording not on its list. There is nothing to guess anymore: while
 * `liveToolName` is null, nothing has run yet, so the label says exactly
 * that instead of speculating about which tool is coming.
 */
function AgentWorking({ liveToolName }: { liveToolName: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, []);
  const label = liveToolName
    ? `Running: ${TOOL_LABELS[liveToolName] ?? liveToolName.replaceAll("_", " ")}`
    : elapsed < 1_500
      ? "Contacting warehouse agent"
      : "Waiting for verified response";

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
  liveToolName,
  scanAttached,
  identityAttached,
  onSend,
  onRetry,
  identification,
  confirmed,
  identityRejected,
  identityBusy,
  identityError,
  onSelectIdentity,
  onRejectIdentity,
  onRegisterNewPart,
  registeringPart,
  registerError,
  approval,
  outcome,
  onDecide,
  gantry,
  latestMovement,
  workflow,
  materialsPlan,
  materialsPlanCheck,
  onDismissMaterialsPlan,
  latestAudit,
  onAuditChanged = () => {},
  detectedName,
  active = true,
}: {
  turns: AgentTurn[];
  busy: boolean;
  unavailable: boolean;
  error: string | null;
  /** The real tool the agent is running right now, polled — never a guess. Null before any tool has fired. */
  liveToolName: string | null;
  scanAttached: boolean;
  identityAttached: boolean;
  onSend: (message: string) => void;
  onRetry: () => void;
  /** Trailing "current state" cards — see the block comment above. Each is null/absent when it does not apply. */
  identification: PendingIdentification | null;
  confirmed: ConfirmedIdentity | null;
  identityRejected: boolean;
  identityBusy: boolean;
  identityError: string | null;
  onSelectIdentity: (partId: string) => void;
  onRejectIdentity: () => void;
  onRegisterNewPart: () => void;
  registeringPart: boolean;
  registerError: string | null;
  approval: PendingApprovalView | null;
  outcome: ApprovalOutcome | null;
  onDecide: (decision: "APPROVE" | "DENY") => void;
  gantry: GantryStatus | null;
  latestMovement: MovementRowView | null;
  workflow: WarehouseGraphResult | null;
  materialsPlan: { requirements: MaterialRequirementView[] } | null;
  materialsPlanCheck: MaterialsPlanCheckView | null;
  /** Retires the build-plan pipeline card for good — see the card's own comment below. */
  onDismissMaterialsPlan: () => void;
  latestAudit: InventoryAuditView | null;
  /** Re-reads the warehouse snapshot after a human applies/dismisses an audit observation. */
  onAuditChanged?: () => void;
  /** The vision-detected name for the current scan, if any — used only in the identification card's "register as new" copy. */
  detectedName: string | null;
  /** Keep draft/history mounted while another workspace tab is selected. */
  active?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [turnsPresentAtMount] = useState(() => new Set(turns.map((turn) => turn.id)));
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Ref, not state: read/written on every scroll/content-growth tick, and
  // must never itself trigger a re-render.
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // The overview intentionally includes the latest durable audit for machine
  // telemetry and recovery. That does not make a settled historical run part
  // of this freshly mounted chat session. Remember an audit only if
  // this page actually observed it while it was live or awaiting a decision;
  // once remembered, its terminal result may remain long enough for the
  // existing SettlingCard animation. An unresolved decision still reappears
  // after refresh because it genuinely needs operator attention.
  const auditNeedsAttention = Boolean(
    latestAudit &&
      (latestAudit.status === "RUNNING" ||
        latestAudit.status === "PENDING" ||
        latestAudit.bins.some((bin) => bin.awaitingConfirmation)),
  );
  const [auditDisplayState, setAuditDisplayState] = useState<{
    auditRunId: string | null;
    observedLive: boolean;
  }>(() => ({
    auditRunId: latestAudit?.auditRunId ?? null,
    observedLive: auditNeedsAttention,
  }));
  let currentAuditDisplayState = auditDisplayState;
  if (latestAudit && latestAudit.auditRunId !== auditDisplayState.auditRunId) {
    currentAuditDisplayState = {
      auditRunId: latestAudit.auditRunId,
      observedLive: auditNeedsAttention,
    };
    setAuditDisplayState(currentAuditDisplayState);
  } else if (auditNeedsAttention && !auditDisplayState.observedLive) {
    currentAuditDisplayState = { ...auditDisplayState, observedLive: true };
    setAuditDisplayState(currentAuditDisplayState);
  }
  const displayedAudit =
    latestAudit &&
    (auditNeedsAttention ||
      (currentAuditDisplayState.auditRunId === latestAudit.auditRunId &&
        currentAuditDisplayState.observedLive))
      ? latestAudit
      : null;

  // Passive auto-follow while pinned to the bottom: an instant scrollTop
  // assignment, not an animation. Content grows dozens of times a second
  // while a reply streams in (onProgress fires per token/frame), and easing
  // toward a constantly-moving target was exactly what produced the
  // reported jitter — every new pixel of growth retargeted the animation
  // and any manual scroll input mid-flight had to fight it. An instant
  // snap has no such race: it always lands exactly at the true bottom, so
  // the next scroll event reports "at bottom" correctly and consistently.
  const scrollToLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!active || !transcript || !followLatest.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [active]);

  // The explicit "Jump to latest" affordance is a one-off, deliberate user
  // action — unlike passive auto-follow, a single smooth scroll here has
  // nothing to compete with, so it can afford the nicer animation.
  const jumpToLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    followLatest.current = true;
    setShowLatest(false);
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [reducedMotion]);

  useEffect(() => {
    const observer = new ResizeObserver(scrollToLatest);
    if (contentRef.current) observer.observe(contentRef.current);
    if (transcriptRef.current) observer.observe(transcriptRef.current);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  // A live sweep is never closable: the Dismiss control appears only once
  // there is nothing left running to watch. A plan with no check row yet IS
  // dismissible — otherwise a plan whose stock check never materialised would
  // be pinned with no way to clear it — and if a sweep then does start, the
  // card comes back, which is correct: that is a machine physically moving.
  // `session` is what actually forgets the check; the card's own fade would
  // otherwise be undone by the very next poll, which keeps returning this
  // browser session's latest check row.
  const materialsPipelineDismissible =
    materialsPlanCheck === null || !materialsCheckRunning(materialsPlanCheck);
  const dismissMaterialsPipeline = useCallback(() => {
    onDismissMaterialsPlan();
    scrollToLatest();
  }, [onDismissMaterialsPlan, scrollToLatest]);

  // A new trailing card (or an existing one changing state, e.g. approval ->
  // executing -> settled) should bring itself into view exactly like a new
  // turn does — this key changes whenever any of them meaningfully change.
  const trailingKey = [
    identification?.resolutionId,
    confirmed?.resolutionId,
    identityRejected,
    approval?.approvalId,
    outcome?.kind,
    workflow?.workflow,
    workflow?.status,
    materialsPlan?.requirements.length,
    materialsPlanCheck?.id,
    materialsPlanCheck?.status,
    materialsPlanCheck?.binsCompleted,
    displayedAudit?.auditRunId,
    displayedAudit?.status,
  ].join("|");

  useEffect(() => scrollToLatest(), [busy, scrollToLatest, turns.length, trailingKey]);

  // Keep one-line messages compact, grow smoothly with wrapped/newline text,
  // then collapse again as the operator deletes or sends it. The cap keeps
  // the transcript visible; beyond it only the composer itself scrolls.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const nextHeight = Math.min(composer.scrollHeight, 112);
    composer.style.height = `${nextHeight}px`;
    composer.style.overflowY = composer.scrollHeight > 112 ? "auto" : "hidden";
  }, [draft]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    followLatest.current = true;
    setShowLatest(false);
    setDraft("");
    onSend(trimmed);
  };

  return (
    <Panel
      title="Warehouse agent"
      className="h-full min-h-0 overflow-hidden"
      bodyClassName="flex min-h-0 flex-col"
      meta={
        scanAttached ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(91,157,217,0.8)]" />
            {identityAttached ? "scan + identity" : "scan attached"}
          </span>
        ) : undefined
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
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
          tabIndex={0}
          aria-label="Warehouse agent conversation"
          // The scroll position itself is the only source of truth for
          // "is the operator following along." A wheel/touch/key event says
          // nothing on its own — the trackpad's own inertial scrolling keeps
          // firing wheel events after the gesture ends, and one micro-tick
          // at the very bottom used to be enough to flip into "away" mode
          // and pop up "Jump to latest" even though nothing had moved.
          onScroll={() => {
            const element = transcriptRef.current;
            if (!element) return;
            const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
            const nearBottom = distanceFromBottom < 48;
            followLatest.current = nearBottom;
            setShowLatest(!nearBottom);
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
        >
          <div ref={contentRef} className="space-y-4">
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

          {busy && <AgentWorking liveToolName={liveToolName} />}

          {/* Trailing "current state" cards — the live tail of the conversation.
              Each one is the SAME component that used to sit beside the chat as
              its own panel; only where it mounts changed. They update in place
              (e.g. an approval card moves pending -> executing -> settled)
              rather than stacking a new card per state change. */}
          {(identification || identityRejected) && (
            <div className="animate-fade-up">
              <CatalogResolutionCard
                identification={identification}
                confirmed={confirmed}
                rejected={identityRejected}
                busy={identityBusy}
                error={identityError}
                detectedName={detectedName}
                onSelect={onSelectIdentity}
                onReject={onRejectIdentity}
                onRegisterNewPart={onRegisterNewPart}
                registeringPart={registeringPart}
                registerError={registerError}
              />
            </div>
          )}

          {(approval || outcome) && (
            <SettlingCard
              cardKey={
                approval
                  ? `approval:${approval.approvalId}`
                  : `outcome:${outcome?.kind}:${outcome?.message}`
              }
              // A pending decision, an in-flight execution and a cancellation
              // still being submitted all stay. An answered one goes — UNLESS
              // it was an APPROVE whose Movement actually failed on the
              // machine: `outcome.kind` only tells us the decision was
              // submitted, never whether the physical action worked, so that
              // has to come from the re-read Movement row instead.
              settled={
                approval === null &&
                SETTLED_OUTCOMES.has(outcome?.kind ?? "") &&
                !(outcome?.kind === "SETTLED" && latestMovement?.status === "FAILED")
              }
              dismissible={outcome?.kind === "SETTLED" && latestMovement?.status === "FAILED"}
              onDismissed={scrollToLatest}
            >
              <ApprovalCard
                approval={approval}
                outcome={outcome}
                busy={busy}
                latestMovement={latestMovement}
                gantry={gantry}
                onDecide={onDecide}
              />
            </SettlingCard>
          )}

          {workflow && (
            <SettlingCard
              cardKey={`workflow:${workflow.operationId}:${workflow.status}`}
              // BLOCKED is not finished — it is a workflow waiting on a human
              // decision, and hiding it would hide the reason for the card
              // right next to it. FAILED must not auto-hide either, same
              // reasoning as the approval card above: it can mean physical
              // reconciliation is needed, so it gets a manual Dismiss instead.
              settled={workflow.status === "COMPLETED"}
              dismissible={workflow.status === "FAILED"}
              onDismissed={scrollToLatest}
            >
              <WorkflowPanel workflow={workflow} />
            </SettlingCard>
          )}

          {(materialsPlan || materialsPlanCheck) && (
            <SettlingCard
              // Keyed on the check, not on its status: a card the operator is
              // reading must not restart its own life because the sweep moved
              // from RUNNING to COMPLETED underneath them.
              cardKey={`materials-pipeline:${
                materialsPlanCheck?.id ?? `planning:${materialsPlan?.requirements.length ?? 0}`
              }`}
              // NEVER auto-fades, in ANY of its states. Same rule the approval
              // and workflow cards apply to a FAILED outcome: this is the
              // answer to a question the operator actually asked ("what do I
              // need, and have we got it?"), and an all-SHORTAGE report is
              // precisely the case where they need time to read it and decide
              // what to source. It vanishing after eight seconds is the exact
              // behaviour that was reported as confusing, so it gets a manual
              // Dismiss instead — offered only once nothing is still running,
              // since a live sweep must never be closable mid-flight.
              settled={false}
              dismissible={materialsPipelineDismissible}
              onDismissed={dismissMaterialsPipeline}
            >
              <MaterialsPlanPipelineCard
                // The polled check carries its own requirements copy, so the
                // list survives later turns (which clear the per-turn
                // materialsPlan) and a page reload.
                requirements={
                  materialsPlan?.requirements ?? materialsPlanCheck?.requirements ?? []
                }
                check={materialsPlanCheck}
              />
            </SettlingCard>
          )}

          {displayedAudit && (
            <SettlingCard
              cardKey={`audit:${displayedAudit.auditRunId}:${displayedAudit.status}`}
              // A bin still awaiting a human's apply/dismiss decision must
              // never auto-hide, even once the run itself finished — the run
              // reaching a terminal status only means the machine is done;
              // it says nothing about whether a person has answered yet. A
              // FAILED run must not auto-hide either, same reasoning as the
              // approval card above — it gets a manual Dismiss instead.
              settled={
                (displayedAudit.status === "COMPLETED" || displayedAudit.status === "COMPLETED_WITH_ISSUES") &&
                !displayedAudit.bins.some((bin) => bin.awaitingConfirmation)
              }
              dismissible={displayedAudit.status === "FAILED"}
              onDismissed={scrollToLatest}
            >
              <InventoryAuditPanel audit={displayedAudit} onChanged={onAuditChanged} />
            </SettlingCard>
          )}
          </div>
        </div>

        {showLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="shrink-0 self-center rounded-full border border-accent-soft bg-accent-tint px-3 py-1 text-[11px] text-accent"
          >
            Jump to latest ↓
          </button>
        )}

        <div className="flex shrink-0 flex-wrap gap-1.5">
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
          className="flex shrink-0 items-end gap-2 rounded-xl border border-line bg-bg-elevated p-1.5 transition-colors focus-within:border-accent-soft"
        >
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask the warehouse…"
            aria-label="Message the warehouse agent"
            disabled={busy}
            className="min-h-8 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
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
