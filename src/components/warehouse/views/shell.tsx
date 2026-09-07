"use client";

/**
 * The frame every page shares: one width, one rhythm, and a heading that says
 * what this page is for.
 *
 * The subtitle is not decoration. Four pages mean an operator can arrive
 * anywhere, and each one has to state whether what it shows is authoritative
 * warehouse truth or a local convenience — the distinction the whole system
 * is built on.
 */
export function PageShell({
  title,
  intent,
  children,
  footer,
}: {
  title: string;
  intent: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6 lg:px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-xs text-ink-muted">{intent}</p>
      </div>
      {children}
      {footer ? (
        <footer className="border-t border-line-soft pt-4 text-[11px] leading-relaxed text-ink-faint">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
