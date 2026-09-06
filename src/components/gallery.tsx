"use client";

import { useState } from "react";
import type { Measurement, Shot } from "@/lib/shots-db";
import type { ScanResult } from "@/lib/warehouse/scan-types";
import { ShotCard } from "@/components/shot-card";
import { Lightbox } from "@/components/lightbox";

/**
 * Recent scans — LOCAL scan history, and nothing more.
 *
 * These frames live in this browser's IndexedDB. They are not warehouse
 * state: a shot here means "the camera saw this", never "the warehouse holds
 * this". Inventory, bins and movements come from the database, and the two are
 * deliberately not blended — a deleted shot changes no stock, and stock
 * changes no shot.
 *
 * Secondary to the warehouse workflow by default: collapsed, below the
 * operational panels, and reusing the existing ShotCard and Lightbox rather
 * than reimplementing them.
 */
export function Gallery({
  shots,
  onDelete,
  onMeasured,
}: {
  shots: Shot[];
  onDelete: (id: string) => void;
  onMeasured: (id: string, measurement: Measurement, scanResult?: ScanResult) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const openShot = shots.find((shot) => shot.id === openId) ?? null;

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">
            Recent scans
          </h2>
          <span className="font-mono text-[10px] text-ink-faint">
            {shots.length} {shots.length === 1 ? "frame" : "frames"} · local to this browser
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] text-ink-muted transition-colors hover:border-accent-soft hover:text-accent"
        >
          {expanded ? "Hide" : "Show"}
        </button>
      </header>

      {expanded && (
        <div className="p-4">
          {shots.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs text-ink-faint">
              No scans captured in this browser yet.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
              {shots.map((shot, index) => (
                <ShotCard
                  key={shot.id}
                  shot={shot}
                  index={index}
                  onOpen={() => setOpenId(shot.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {openShot && (
        <Lightbox
          shot={openShot}
          onClose={() => setOpenId(null)}
          onDelete={(id) => {
            onDelete(id);
            setOpenId(null);
          }}
          onMeasured={onMeasured}
        />
      )}
    </section>
  );
}
