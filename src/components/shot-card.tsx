"use client";

import type { Shot } from "@/lib/shots-db";
import { RulerIcon } from "@/components/icons";

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ShotCard({
  shot,
  index,
  onOpen,
}: {
  shot: Shot;
  index: number;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{ animationDelay: `${Math.min(index, 10) * 45}ms` }}
      className="animate-fade-up group relative block aspect-[4/3] w-full overflow-hidden rounded-2xl border border-line bg-bg-elevated text-left shadow-[0_8px_20px_-12px_rgba(0,0,0,0.6)] transition-all duration-300 hover:-translate-y-1 hover:border-accent-soft/50 hover:shadow-[0_16px_32px_-14px_rgba(0,0,0,0.7)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shot.dataUrl}
        alt={`Shot captured ${formatTime(shot.createdAt)}`}
        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        loading="lazy"
      />
      {shot.measurement && (
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-white/15 bg-black/55 px-2 py-1 text-accent backdrop-blur-sm">
          <RulerIcon className="h-3 w-3" />
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 via-black/10 to-transparent px-3 pb-2.5 pt-6 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <span className="font-mono text-[10px] tracking-wide text-white/90">
          {formatTime(shot.createdAt)}
        </span>
        {shot.measurement && (
          <span className="font-mono text-[10px] tracking-wide text-accent">
            {shot.measurement.lengthMM.toFixed(0)}×{shot.measurement.widthMM.toFixed(0)}mm
          </span>
        )}
      </div>
    </button>
  );
}
