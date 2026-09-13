"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWarehouseSession } from "./session";

/**
 * The command centre's menu (Milestone 13 split).
 *
 * FOUR PAGES, GROUPED BY WHAT THE OPERATOR IS DOING:
 *
 *   Warehouse  — the main view: bins, inventory, machine and agent.
 *   Scan       — the stationary camera and identification flow.
 *   History    — what has already happened: movements, local scans.
 *   Activity   — how the agent got there: traces.
 *
 * The whole live loop stays on ONE page on purpose. Milestone 13 validated
 * that scan → identify → approve → see inventory update works without
 * navigating, and a menu that broke that would make the system worse, not
 * better.
 *
 * The badges are not decoration. A count beside "Warehouse" is how an
 * operator notices, from any page, that the server is holding a decision
 * open — the approval that would otherwise be invisible while they are
 * reading history or standing at the scan station. The decision itself lives
 * inline in the Warehouse Agent conversation on that page, never a separate
 * panel. GANTRY MODE stays pinned across every page so nothing can imply that
 * real hardware exists.
 */

interface Tab {
  href: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

/** Simple line icons, inline so the page loads no icon library. */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TABS: Tab[] = [
  {
    href: "/",
    label: "Workspace",
    hint: "Bins, inventory, gantry and RackHand Agent",
    icon: (
      <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
        <path d="M2.5 5.5h15v11h-15z" {...stroke} />
        <path d="M2.5 10.5h15M7.5 5.5v11M12.5 5.5v11" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/scan",
    label: "Scan",
    hint: "Stationary camera and part identification",
    icon: (
      <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
        <circle cx="10" cy="10.5" r="3.2" {...stroke} />
        <path d="M2.5 6.5h3l1.4-2h6.2l1.4 2h3v9h-15z" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/history",
    label: "History",
    hint: "Movements and local scans",
    icon: (
      <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
        <circle cx="10" cy="10" r="7.2" {...stroke} />
        <path d="M10 5.8v4.4l2.8 1.8" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/activity",
    label: "Activity",
    hint: "Agent traces",
    icon: (
      <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
        <path d="M2.5 10.5h3l2-5 3 10 2.5-6.5 1.5 3h3" {...stroke} />
      </svg>
    ),
  },
];

export function WarehouseNav() {
  const pathname = usePathname();
  const { totals, gantry, approval, identification } = useWarehouseSession();

  // One number, so a decision waiting on a person is visible from any page.
  const waiting = (approval ? 1 : 0) + (identification ? 1 : 0);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-lg border border-accent/40 bg-accent-tint text-accent"
          >
            <svg viewBox="0 0 20 20" className="size-4">
              <path d="M3 3v14M17 3v14M3 5h14M3 15h14" {...stroke} />
              <path
                d="M10 5v4.5M7 8.5v2a3 3 0 0 0 6 0v-2M7 10H5.5M13 10h1.5"
                {...stroke}
              />
            </svg>
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight text-ink">
              RackHand
            </span>
          </span>
        </Link>

        <nav
          aria-label="Command centre sections"
          className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-line-soft bg-bg-elevated/70 p-1 lg:order-none lg:mx-0 lg:w-auto"
        >
          {TABS.map((tab) => {
            const active =
              pathname === tab.href ||
              (tab.href === "/" && pathname === "/warehouse");
            const badge = tab.href === "/" && waiting > 0 ? waiting : 0;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                title={tab.hint}
                aria-current={active ? "page" : undefined}
                className={[
                  "relative flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-surface text-ink ring-1 ring-line"
                    : "text-ink-muted hover:bg-surface/60 hover:text-ink",
                ].join(" ")}
              >
                <span className={active ? "text-accent" : "text-ink-faint"}>
                  {tab.icon}
                </span>
                {tab.label}
                {badge > 0 ? (
                  <span
                    className="ml-0.5 grid size-4 place-items-center rounded-full bg-warn font-mono text-[10px] font-semibold text-bg"
                    aria-label={`${badge} waiting on you`}
                  >
                    {badge}
                  </span>
                ) : null}
                {/* A word, never colour alone — the active tab is also marked
                  for assistive technology by aria-current above. */}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 -bottom-px h-px bg-accent"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px]">
          <span className="hidden text-ink-faint sm:inline">
            Stock{" "}
            <span className="text-ink-muted">{totals?.units ?? "—"}</span>{" "}
            units ·{" "}
            <span className="text-ink-muted">
              {totals?.distinctParts ?? "—"}
            </span>{" "}
            parts
          </span>
          <span className="hidden text-ink-faint md:inline">
            Bins{" "}
            <span className="text-ink-muted">
              {totals ? `${totals.binsAvailable} available` : "—"}
            </span>
          </span>
          {/* <span className="inline-flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-1 font-medium tracking-[0.1em] text-warn">
            <span aria-hidden="true">●</span>
            GANTRY MODE: {gantry?.mode ?? "SIMULATION"}
          </span> */}
        </div>
      </div>
    </header>
  );
}
