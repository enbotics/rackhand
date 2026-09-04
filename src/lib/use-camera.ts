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
  const [mirrored, setMirrored] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
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
          video: preferredDeviceId
            ? { deviceId: { exact: preferredDeviceId } }
            : { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        setStreamVersion((v) => v + 1);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings();
        if (settings?.deviceId) setDeviceId(settings.deviceId);
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
    setStreamVersion((v) => v + 1);
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
    stream: streamRef.current,
    streamVersion,
    activeDeviceLabel,
    start,
    stop,
    switchDevice,
  };
}
