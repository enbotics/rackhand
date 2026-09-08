"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useCamera } from "@/lib/use-camera";
import type { Shot } from "@/lib/shots-db";

/**
 * ONE camera device for the whole application.
 *
 * WHY THIS EXISTS. `useCamera()` used to be instantiated inside CameraStage,
 * which mounts only on /scan. That made the camera a property of a page: an
 * inventory audit started from the Warehouse Agent chat on the landing page
 * had literally no live stream to service its capture request, and failed
 * server-side with `capture_station_unavailable` — the operator was never
 * even shown a camera. Lifting the hook to the layout (above the router
 * outlet, next to WarehouseSessionProvider and for the same reason) means the
 * stream survives navigation and is reachable from any page.
 *
 * There is exactly ONE getUserMedia stream. Every preview — the /scan stage,
 * the guided putaway placement step, the audit capture dialog — binds that
 * same MediaStream to its own `<video>`, which is free; opening a second
 * device would waste it and can fail outright with "camera already in use".
 *
 * CAPTURE LIVES HERE TOO, on a permanently mounted off-screen `<video>`, so
 * `captureFrame()` works even when no visible preview is on the page. It is
 * off-screen rather than `display: none` on purpose: a display:none video is
 * allowed to stop decoding frames, which would hand back a blank capture.
 */

export interface SharedCamera extends ReturnType<typeof useCamera> {
  /** Grabs the current live frame as a JPEG Shot. Null unless the camera is live and has decoded a frame. */
  captureFrame: () => Shot | null;
  /** The one live MediaStream, for a read-only `<video>` preview. Null unless live. */
  getStream: () => MediaStream | null;
}

const CameraContext = createContext<SharedCamera | null>(null);

/** The shared camera. Throws outside the provider, on purpose. */
export function useSharedCamera(): SharedCamera {
  const camera = useContext(CameraContext);
  if (!camera) {
    throw new Error("useSharedCamera must be used inside <CameraProvider>.");
  }
  return camera;
}

export function CameraProvider({ children }: { children: React.ReactNode }) {
  const camera = useCamera();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camera.stream;
  }, [camera.stream]);

  /**
   * Unchanged imaging from the scanner milestones: same canvas draw honouring
   * the mirror setting, same JPEG quality, same Shot shape. Only the element
   * it reads from moved.
   */
  const captureFrame = useCallback((): Shot | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || camera.status !== "live") return null;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    if (camera.mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      createdAt: Date.now(),
      width: w,
      height: h,
      deviceLabel: camera.activeDeviceLabel,
    };
  }, [camera.activeDeviceLabel, camera.mirrored, camera.status]);

  const getStream = useCallback(
    () => (camera.status === "live" ? camera.stream : null),
    [camera.status, camera.stream],
  );

  const value = useMemo<SharedCamera>(
    () => ({ ...camera, captureFrame, getStream }),
    [camera, captureFrame, getStream],
  );

  return (
    <CameraContext.Provider value={value}>
      {children}
      {/* Off-screen but composited — the capture source of record. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
      />
      <canvas ref={canvasRef} className="hidden" />
    </CameraContext.Provider>
  );
}
