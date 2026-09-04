"use client";

import { useEffect, useRef, useState } from "react";
import { useCamera } from "@/lib/use-camera";
import type { Shot } from "@/lib/shots-db";
import {
  AlertIcon,
  CameraIcon,
  ChevronDownIcon,
  FlipIcon,
} from "@/components/icons";

export function CameraStage({
  onCapture,
}: {
  onCapture: (shot: Shot) => void;
}) {
  const camera = useCamera();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [flash, setFlash] = useState<"off" | "on" | "fade">("off");
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = camera.stream;
    }
  }, [camera.stream]);

  const capture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || camera.status !== "live") return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (camera.mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const shot: Shot = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      dataUrl,
      createdAt: Date.now(),
      width: w,
      height: h,
      deviceLabel: camera.activeDeviceLabel,
    };
    onCapture(shot);

    setPressed(true);
    setTimeout(() => setPressed(false), 150);

    // paint the flash fully opaque with no transition, then fade it out
    // on the next frame — avoids relying on CSS animation fill-mode
    setFlash("on");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setFlash("fade"));
    });
  };

  return (
    <div className="w-full">
      <div className="glass relative overflow-hidden rounded-3xl border border-line shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)]">
        {/* status pill */}
        <div className="pointer-events-none absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full border border-line bg-bg/60 px-3 py-1.5 text-[11px] font-medium tracking-wide text-ink-muted backdrop-blur-md">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              camera.status === "live"
                ? "bg-accent animate-glow-pulse"
                : "bg-ink-faint"
            }`}
          />
          {camera.status === "live" ? "Live preview" : "Standby"}
        </div>

        <div className="relative aspect-video w-full overflow-hidden bg-bg-elevated">
          {camera.status === "live" && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full object-cover transition-transform duration-300 ${
                camera.mirrored ? "-scale-x-100" : ""
              }`}
            />
          )}

          {camera.status !== "live" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-8 text-center animate-fade-in">
              {camera.status === "requesting" && (
                <>
                  <div className="h-9 w-9 rounded-full border-2 border-line border-t-accent animate-spin-slow" />
                  <p className="text-sm text-ink-muted">
                    Asking the browser to open the CM717…
                  </p>
                </>
              )}

              {camera.status === "idle" && (
                <>
                  <div className="rounded-2xl border border-line bg-surface p-4 text-accent animate-breathe">
                    <CameraIcon className="h-7 w-7" />
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-xl font-semibold text-ink">
                      Wake the camera
                    </h2>
                    <p className="max-w-xs text-sm leading-relaxed text-ink-muted">
                      Plug in the UGREEN CM717, then start the preview.
                      Nothing leaves this browser tab.
                    </p>
                  </div>
                  <button
                    onClick={() => camera.start()}
                    className="mt-1 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition-all duration-200 hover:bg-accent-2 hover:shadow-[0_0_24px_rgba(242,167,101,0.35)] active:scale-95"
                  >
                    Start preview
                  </button>
                </>
              )}

              {(camera.status === "denied" ||
                camera.status === "error" ||
                camera.status === "unsupported") && (
                <>
                  <div className="rounded-2xl border border-danger/30 bg-danger-soft p-4 text-danger">
                    <AlertIcon className="h-7 w-7" />
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-xl font-semibold text-ink">
                      Camera stayed dark
                    </h2>
                    <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
                      {camera.errorMessage ??
                        "Something kept the preview from starting."}
                      {camera.status === "denied" &&
                        " Check the site permissions in your browser's address bar and allow the camera."}
                    </p>
                  </div>
                  <button
                    onClick={() => camera.start()}
                    className="mt-1 rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink transition-all duration-200 hover:border-accent hover:text-accent active:scale-95"
                  >
                    Try again
                  </button>
                </>
              )}
            </div>
          )}

          {/* shutter flash: opacity driven via inline style, no CSS fill-mode involved */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-white"
            style={{
              opacity: flash === "on" ? 0.9 : 0,
              transition: flash === "fade" ? "opacity 300ms ease-out" : "none",
            }}
          />
        </div>

        <canvas ref={canvasRef} className="hidden" />

        {/* control strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/70 px-4 py-3">
          <div className="flex items-center gap-2">
            {camera.devices.length > 1 && camera.status === "live" && (
              <div className="relative">
                <select
                  value={camera.deviceId ?? ""}
                  onChange={(e) => camera.switchDevice(e.target.value)}
                  className="appearance-none rounded-full border border-line bg-bg-elevated py-2 pl-3 pr-8 text-xs text-ink-muted outline-none transition-colors hover:border-accent-soft focus:border-accent"
                >
                  {camera.devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              </div>
            )}
            {camera.status === "live" && (
              <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">
                {camera.activeDeviceLabel ?? "External camera"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={camera.setMirrored}
              title="Flip preview"
              disabled={camera.status !== "live"}
              className="rounded-full border border-line p-2 text-ink-muted transition-colors hover:border-accent-soft hover:text-accent disabled:pointer-events-none disabled:opacity-30"
            >
              <FlipIcon className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={capture}
              disabled={camera.status !== "live"}
              aria-label="Take a shot"
              className={`group relative ml-1 grid h-12 w-12 place-items-center rounded-full border-2 border-accent transition-transform duration-150 disabled:pointer-events-none disabled:opacity-30 ${
                pressed ? "scale-90" : "scale-100"
              }`}
            >
              <span className="h-9 w-9 rounded-full bg-gradient-to-br from-accent to-accent-2 transition-all duration-150 group-active:h-7 group-active:w-7" />
            </button>

            {camera.status === "live" && (
              <button
                type="button"
                onClick={camera.stop}
                className="ml-1 rounded-full border border-line px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-danger/40 hover:text-danger"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
