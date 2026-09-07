"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "live"
  | "denied"
  | "unsupported"
  | "error";

export function useCamera() {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Off by default: a selfie-style mirrored preview makes sense for a
  // face-to-camera video call, but this rig shoots objects on a desk from
  // overhead, and lib/scan/matCalibration.ts's 4-QR winding-order check
  // explicitly assumes a non-mirrored front view (see its
  // isConvexWithExpectedWinding comment) — a mirrored capture flips that
  // winding and fails calibration on every single shot, deterministically.
  const [mirrored, setMirrored] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  /**
   * Requests the highest resolution the device offers, regardless of which
   * capture path (initial open vs. explicit device switch) is calling.
   * Previously `switchDevice` passed only `{ deviceId }`, silently dropping
   * the resolution hint and letting the browser fall back to a lower default
   * — starving a QR decode of pixels-on-target for markers already small at
   * distance (see lib/scan/qrDetector.ts).
   */
  function buildVideoConstraints(deviceId?: string): MediaTrackConstraints {
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // "ideal" only requests; the browser still negotiates down to
      // whatever the device actually supports.
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    };
  }

  /**
   * Best-effort continuous autofocus. Not standardized (Chrome-only, via the
   * non-spec MediaTrackCapabilities/Constraints focus fields) and many cheap
   * webcams don't expose it at all — this must never throw or block capture
   * on an unsupported device, it can only help when it's actually available.
   *
   * Logs what it found either way — diagnosing whether a given camera
   * exposes focus/zoom control at all is otherwise pure guesswork, since
   * DevTools has no built-in view for MediaTrackCapabilities.
   */
  async function tryEnableContinuousFocus(track: MediaStreamTrack): Promise<void> {
    try {
      const capabilities = track.getCapabilities?.() as
        | (MediaTrackCapabilities & {
            focusMode?: string[];
            focusDistance?: { min?: number; max?: number; step?: number };
            zoom?: { min?: number; max?: number; step?: number };
          })
        | undefined;
      console.log("[camera] capabilities:", capabilities);

      if (!capabilities?.focusMode?.includes("continuous")) {
        console.log("[camera] no 'continuous' focusMode reported — camera is likely fixed-focus, or exposes no focus control to the browser at all.");
        return;
      }
      await track.applyConstraints({
        advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
      });
      console.log("[camera] applied focusMode=continuous");
    } catch (err) {
      console.log("[camera] focus control unsupported on this browser/camera:", err);
    }
  }

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "videoinput"));
    } catch {
      // enumeration failing is non-fatal; the live stream still works
    }
  }, []);

  const start = useCallback(
    async (preferredDeviceId?: string) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        setErrorMessage("This browser doesn't expose camera access (getUserMedia).");
        return;
      }

      setStatus("requesting");
      setErrorMessage(null);
      stopStream();

      try {
        const constraints: MediaStreamConstraints = {
          video: buildVideoConstraints(preferredDeviceId),
          audio: false,
        };
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = newStream;
        setStream(newStream);
        const track = newStream.getVideoTracks()[0];
        const settings = track?.getSettings();
        if (settings?.deviceId) setDeviceId(settings.deviceId);
        if (track) await tryEnableContinuousFocus(track);
        setStatus("live");
        await refreshDevices();
      } catch (err) {
        stopStream();
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setStatus("denied");
          setErrorMessage("Camera access was denied.");
        } else if (
          err instanceof DOMException &&
          (err.name === "NotFoundError" || err.name === "OverconstrainedError")
        ) {
          setStatus("error");
          setErrorMessage("No matching camera was found. Try another device.");
        } else {
          setStatus("error");
          setErrorMessage(
            err instanceof Error ? err.message : "Could not open the camera."
          );
        }
      }
    },
    [refreshDevices, stopStream]
  );

  const switchDevice = useCallback(
    (id: string) => {
      start(id);
    },
    [start]
  );

  const stop = useCallback(() => {
    stopStream();
    setStatus("idle");
  }, [stopStream]);

  useEffect(() => stopStream, [stopStream]);

  const activeDeviceLabel =
    devices.find((d) => d.deviceId === deviceId)?.label ?? null;

  return {
    status,
    errorMessage,
    devices,
    deviceId,
    mirrored,
    setMirrored: () => setMirrored((m) => !m),
    stream,
    activeDeviceLabel,
    start,
    stop,
    switchDevice,
  };
}
