"use client";

import { useEffect, useRef } from "react";

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
  viewport = false,
}: {
  title: string;
  intent: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Desktop command workspace; other routes keep their document layout. */
  viewport?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewport || !root.current) return;
    const update = () => {
      const element = root.current;
      if (element) element.style.setProperty("--workspace-top", `${element.getBoundingClientRect().top + window.scrollY}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    const nav = document.querySelector("header");
    if (nav) observer.observe(nav);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [viewport]);
  return (
    <div ref={root} className={`mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6 lg:px-6 ${viewport ? "warehouse-workspace" : ""}`}>
      <div className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-xs text-ink-muted">{intent}</p>
      </div>
      {children}
      {footer ? (
        <footer className="shrink-0 border-t border-line-soft pt-4 text-[11px] leading-relaxed text-ink-faint">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
