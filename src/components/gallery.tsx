"use client";

import { useState } from "react";
import type { Measurement, Shot } from "@/lib/shots-db";
import { ShotCard } from "@/components/shot-card";
import { Lightbox } from "@/components/lightbox";
import { FilmIcon } from "@/components/icons";

export function Gallery({
  shots,
  onDelete,
  onMeasured,
}: {
  shots: Shot[];
  onDelete: (id: string) => void;
  onMeasured: (id: string, measurement: Measurement) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const openShot = shots.find((s) => s.id === openId) ?? null;

  return (
    <section className="w-full">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <FilmIcon className="h-4 w-4 text-accent" />
          Shot gallery
        </h2>
        <span className="font-mono text-xs text-ink-faint">
          {shots.length} {shots.length === 1 ? "frame" : "frames"}
        </span>
      </div>

      {shots.length === 0 ? (
        <div className="animate-fade-in rounded-2xl border border-dashed border-line px-6 py-14 text-center">
          <p className="text-sm text-ink-faint">
            Nothing captured yet — every shot you take lands here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {shots.map((shot, i) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              index={i}
              onOpen={() => setOpenId(shot.id)}
            />
          ))}
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
