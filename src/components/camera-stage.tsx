"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSharedCamera } from "@/lib/camera-context";
import type { Shot } from "@/lib/shots-db";
import { AlertIcon, CameraIcon, ChevronDownIcon, FlipIcon } from "@/components/icons";

/**
 * The physical capture stage.
 *
 * The capture pipeline is unchanged from the scanner milestones: the same
 * getUserMedia stream, the same canvas draw honouring the mirror setting, the
 * same JPEG data URL handed to the caller. Milestone 10 changed the words and
 * the controls around it, not the imaging — in particular the mirror default
 * still comes from use-camera.ts, because the 4-QR calibration winding check
 * fails deterministically on a mirrored frame.
 *
 * WHAT THIS COMPONENT NO LONGER OWNS: the camera itself. The stream and the
 * capture canvas live in CameraProvider (lib/camera-context.tsx), mounted at
 * the layout, so an audit triggered from the Warehouse Agent on another page
 * still has a camera. This is the visible stage for it, not its owner —
 * mirror, device switching and every status message below are unchanged.
 *
 * Camera state is stated on screen in plain language. An operator must never
 * have to open a browser console to find out why nothing happened.
 */
export function CameraStage({
  onCapture,
  scanning = false,
  compact = false,
  disabled = false,
  captureLabel = "Capture & identify",
}: {
  onCapture: (shot: Shot) => void;
  /** True while the captured frame is being measured and matched. */
  scanning?: boolean;
  compact?: boolean;
  disabled?: boolean;
  captureLabel?: string;
}) {
  const camera = useSharedCamera();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [flash, setFlash] = useState<"off" | "on" | "fade">("off");
  const [capturedFrame, setCapturedFrame] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = camera.stream;
    }
  }, [camera.stream]);

  const statusLabel = scanning
    ? "SCANNING…"
    : camera.status === "live"
      ? "CAMERA READY"
      : camera.status === "requesting"
        ? "STARTING CAMERA…"
        : camera.status === "idle"
          ? "CAMERA STANDBY"
          : "CAMERA UNAVAILABLE";

  const statusTone =
    camera.status === "live"
      ? scanning
        ? "text-accent"
        : "text-success"
      : camera.status === "idle" || camera.status === "requesting"
        ? "text-ink-muted"
        : "text-danger";

  /** The imaging is the provider's; the shutter flash is this stage's. */
  const capture = useCallback(() => {
    const shot = camera.captureFrame();
    if (!shot) return;
    setCapturedFrame(shot.dataUrl);
    // paint the flash fully opaque with no transition, then fade it out
    // on the next frame — avoids relying on CSS animation fill-mode
    setFlash("on");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setFlash("fade"));
    });
    onCapture(shot);
  }, [camera, onCapture]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative flex h-full flex-col overflow-hidden rounded-lg border border-line bg-bg-elevated">
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2 rounded-md border border-line bg-bg/80 px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.12em] backdrop-blur-md">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              camera.status === "live"
                ? scanning
                  ? "bg-accent animate-glow-pulse"
                  : "bg-success"
                : camera.status === "idle" || camera.status === "requesting"
                  ? "bg-ink-faint"
                  : "bg-danger"
            }`}
          />
          <span className={statusTone}>{statusLabel}</span>
        </div>

        {/* Contain the whole frame: cropping can hide calibration markers. */}
        <div className={`relative w-full overflow-hidden bg-black/40 ${compact ? "h-[220px]" : "min-h-[260px] flex-1"}`}>
          {camera.status === "live" && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={(event) =>
                setResolution({
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                })
              }
              className={`h-full w-full object-contain ${camera.mirrored ? "-scale-x-100" : ""}`}
            />
          )}

          {camera.status !== "live" && (
            <div className="animate-fade-in absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              {camera.status === "requesting" && (
                <>
                  <div className="animate-spin-slow h-8 w-8 rounded-full border-2 border-line border-t-accent" />
                  <p className="text-sm text-ink-muted">Opening the overhead camera…</p>
                </>
              )}

              {camera.status === "idle" && (
                <>
                  <div className="rounded-lg border border-line bg-surface p-3.5 text-accent">
                    <CameraIcon className="h-6 w-6" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="text-base font-semibold text-ink">Camera standby</h3>
                    <p className="max-w-xs text-xs leading-relaxed text-ink-muted">
                      Mount the overhead camera above the calibration mat, then start the preview.
                      Captured frames are sent to the configured vision service for analysis.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => camera.start()}
                    className="mt-1 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent-2"
                  >
                    Start camera
                  </button>
                </>
              )}

              {(camera.status === "denied" ||
                camera.status === "error" ||
                camera.status === "unsupported") && (
                <>
                  <div className="rounded-lg border border-danger/40 bg-danger-soft p-3.5 text-danger">
                    <AlertIcon className="h-6 w-6" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="text-base font-semibold text-ink">Camera unavailable</h3>
                    <p className="max-w-sm text-xs leading-relaxed text-ink-muted">
                      {camera.errorMessage ?? "The preview could not be started."}
                      {camera.status === "denied" &&
                        " Allow camera access for this site in the browser address bar, then try again."}
                    </p>
                    <p className="max-w-sm text-xs leading-relaxed text-ink-faint">
                      Inventory, the warehouse map, the agent and movement history all keep working
                      without a camera.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => camera.start()}
                    className="mt-1 rounded-lg border border-line px-4 py-2 text-xs font-semibold text-ink transition-colors hover:border-accent hover:text-accent"
                  >
                    Try again
                  </button>
                </>
              )}
            </div>
          )}

          {scanning && (
            <div className="station-scan absolute inset-0" role="status">
              {capturedFrame && (
                // A local, already captured data URL; never re-capture during analysis.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={capturedFrame} alt="Captured frame being analyzed" className="h-full w-full object-contain" />
              )}
              <div className="station-scan-grid absolute inset-0" aria-hidden="true" />
              <div className="station-scan-beam absolute inset-x-0" aria-hidden="true" />
              <div className="absolute inset-x-0 bottom-4 flex justify-center">
                <span className="rounded-full border border-cyan-300/30 bg-slate-950/90 px-4 py-2 font-mono text-[10px] tracking-wider text-cyan-200">ANALYZING CAPTURED FRAME…</span>
              </div>
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

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {camera.devices.length > 1 && camera.status === "live" ? (
              <div className="relative">
                <select
                  value={camera.deviceId ?? ""}
                  onChange={(event) => camera.switchDevice(event.target.value)}
                  aria-label="Select camera"
                  className="appearance-none rounded-md border border-line bg-bg-elevated py-1.5 pl-2.5 pr-7 font-mono text-[11px] text-ink-muted outline-none transition-colors hover:border-accent-soft focus:border-accent"
                >
                  {camera.devices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              </div>
            ) : (
              camera.status === "live" && (
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">
                  {camera.activeDeviceLabel ?? "External camera"}
                </span>
              )
            )}
            {resolution && camera.status === "live" && (
              <span className="font-mono text-[11px] text-ink-faint">
                {resolution.width} × {resolution.height}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={camera.setMirrored}
              title="Flip preview horizontally"
              aria-label="Flip preview horizontally"
              disabled={camera.status !== "live"}
              className="rounded-md border border-line p-1.5 text-ink-muted transition-colors hover:border-accent-soft hover:text-accent disabled:pointer-events-none disabled:opacity-30"
            >
              <FlipIcon className="h-3.5 w-3.5" />
            </button>

            {camera.status === "live" && (
              <button
                type="button"
                onClick={camera.stop}
                className="rounded-md border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-danger/50 hover:text-danger"
              >
                Stop
              </button>
            )}

            {/* Labelled, never icon-only: this is the primary warehouse action. */}
            <button
              type="button"
              onClick={capture}
              disabled={camera.status !== "live" || scanning || disabled}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent-2 disabled:pointer-events-none disabled:opacity-40"
            >
              {scanning ? "Analyzing…" : captureLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
