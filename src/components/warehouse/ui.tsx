import type { ReactNode } from "react";
import type { StatusPresentation, Tone } from "@/lib/warehouse/dashboard-presentation";

/**
 * The command centre's shared card system (Milestone 10).
 *
 * One panel shape, one chip shape, one button shape. The dashboard shows a lot
 * of different state, and the fastest way to make that unreadable is to give
 * every area its own visual language — so every panel below is the same
 * rectangle with the same header, and only the CONTENT differs.
 *
 * Presentational only: no data fetching, no warehouse rules, no decisions.
 */

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-line bg-bg-elevated text-ink-muted",
  accent: "border-accent-soft/60 bg-accent-tint text-accent",
  ok: "border-success/40 bg-success-soft text-success",
  warn: "border-warn/40 bg-warn-soft text-warn",
  danger: "border-danger/40 bg-danger-soft text-danger",
  muted: "border-line-soft bg-bg-elevated text-ink-faint",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-muted",
  accent: "text-accent",
  ok: "text-success",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-ink-faint",
};

export function toneText(tone: Tone): string {
  return TONE_TEXT[tone];
}

/**
 * A status label. The symbol is not decoration — it is the second, non-colour
 * encoding, so the status survives a colour-blind operator and a bad projector.
 */
export function StatusChip({
  status,
  className = "",
}: {
  status: StatusPresentation;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.1em] ${TONE_CHIP[status.tone]} ${className}`}
    >
      <span aria-hidden="true">{status.symbol}</span>
      {status.label}
    </span>
  );
}

/** The one card. Every dashboard area is one of these. */
export function Panel({
  title,
  meta,
  actions,
  children,
  className = "",
  tone,
  bodyClassName = "",
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Highlights a panel that needs the operator's attention. */
  tone?: "attention";
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-xl border bg-surface ${
        tone === "attention" ? "border-accent-soft/70 shadow-[0_0_0_1px_rgba(91,157,217,0.15)]" : "border-line"
      } ${className}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {meta}
          {actions}
        </div>
      </header>
      <div className={`min-h-0 min-w-0 flex-1 p-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Never a blank rectangle: an empty panel still says what it is waiting for. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs leading-relaxed text-ink-faint">
      {children}
    </div>
  );
}

/**
 * An operator-facing failure. Plain language and, where the action is
 * repeatable, a retry — never a JSON dump or a stack trace.
 */
export function ErrorNote({
  children,
  onRetry,
  retryLabel = "Retry",
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2">
      <p className="text-xs leading-relaxed text-danger">{children}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-danger/50 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40";

export const BUTTON_VARIANTS = {
  primary: `${BUTTON_BASE} bg-accent text-bg hover:bg-accent-2`,
  secondary: `${BUTTON_BASE} border border-line text-ink-muted hover:border-accent-soft hover:text-accent`,
  danger: `${BUTTON_BASE} border border-danger/50 text-danger hover:bg-danger/10`,
  approve: `${BUTTON_BASE} bg-success text-bg hover:opacity-90`,
} as const;

/** A labelled figure — dimensions, confidence, counts. */
export function Metric({
  label,
  value,
  unit,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${TONE_TEXT[tone]}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-ink-faint">{unit}</span>}
      </p>
    </div>
  );
}

/** Label/value row used by the gantry and scan panels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-ink">{children}</span>
    </div>
  );
}

const INPUT_BASE =
  "w-full rounded-lg border border-line bg-bg-elevated px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent-soft disabled:opacity-40";

/** Label + input, matching Field's label styling. The three below share this shell. */
function FormRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <FormRow label={label} htmlFor={id}>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={INPUT_BASE}
      />
    </FormRow>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min = 1,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <FormRow label={label} htmlFor={id}>
      <input
        id={id}
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className={INPUT_BASE}
      />
    </FormRow>
  );
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <FormRow label={label} htmlFor={id}>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        className={`${INPUT_BASE} appearance-none`}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </FormRow>
  );
}
