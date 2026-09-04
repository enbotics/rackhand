"use client";

import { useEffect, useState } from "react";
import { CameraStage } from "@/components/camera-stage";
import { Gallery } from "@/components/gallery";
import { addShot, deleteShot, getAllShots, type Measurement, type Shot } from "@/lib/shots-db";

export default function Home() {
  const [shots, setShots] = useState<Shot[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAllShots()
      .then(setShots)
      .finally(() => setLoaded(true));
  }, []);

  const handleCapture = (shot: Shot) => {
    setShots((prev) => [shot, ...prev]);
    addShot(shot).catch(() => {
      // storage failing shouldn't break the live session view
    });
  };

  const handleDelete = (id: string) => {
    setShots((prev) => prev.filter((s) => s.id !== id));
    deleteShot(id).catch(() => {});
  };

  const handleMeasured = (id: string, measurement: Measurement) => {
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, measurement } : s)));
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-12 px-5 py-12 sm:px-8 sm:py-16">
      <header className="animate-fade-up flex flex-col gap-3">
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-accent">
          LOCAL CAPTURE TEST · UGREEN CM717
        </div>
        <h1 className="bg-gradient-to-br from-ink to-ink-muted bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          Safelight
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-ink-muted">
          A quick test bench for the new webcam. Preview it, take a few
          frames, and see how they look — everything stays on this machine.
          Mount the CM717 overhead with the calibration mat in frame to
          measure objects with Gemini.
        </p>
      </header>

      <div
        className="animate-fade-up"
        style={{ animationDelay: "80ms" }}
      >
        <CameraStage onCapture={handleCapture} />
      </div>

      <div
        className="animate-fade-up"
        style={{ animationDelay: "140ms" }}
      >
        {loaded && (
          <Gallery shots={shots} onDelete={handleDelete} onMeasured={handleMeasured} />
        )}
      </div>

      <footer className="mt-4 border-t border-line-soft pt-6 text-xs text-ink-faint">
        Shots are stored locally in this browser (IndexedDB) — nothing is
        uploaded anywhere.
      </footer>
    </div>
  );
}
