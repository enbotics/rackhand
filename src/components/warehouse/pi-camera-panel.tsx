"use client";

import Image from "next/image";

import type { CameraCaptureJobView } from "@/lib/camera/capture-client";

interface PiCameraPanelProps {
  capture: CameraCaptureJobView | null;

  scanning: boolean;

  onScan: () => void;
}

function getStatusText(capture: CameraCaptureJobView | null) {
  if (!capture) {
    return {
      title: "Camera ready",
      detail: "Place the part on the calibration mat, then start the scan.",
    };
  }

  switch (capture.status) {
    case "PENDING":
      return {
        title: "Waiting for camera",
        detail: "The server is waiting for the Raspberry Pi camera worker.",
      };

    case "CLAIMED":
      return {
        title: "Taking photo",
        detail:
          "The Raspberry Pi received the request and is capturing the image.",
      };

    case "UPLOADED":
      return {
        title: "Photo received",
        detail: "The image reached the warehouse server.",
      };

    case "PROCESSING":
      return {
        title: "Analyzing part",
        detail: "Detecting calibration markers and measuring the part.",
      };

    case "COMPLETED":
      return {
        title: "Scan complete",
        detail: "The measurement is ready.",
      };

    case "FAILED":
      return {
        title: "Scan failed",
        detail:
          capture.error?.message ?? "The camera scan could not be completed.",
      };

    case "EXPIRED":
      return {
        title: "Scan expired",
        detail: "The camera did not complete the request in time.",
      };
  }
}

function statusTone(capture: CameraCaptureJobView | null, scanning: boolean) {
  if (capture?.status === "FAILED" || capture?.status === "EXPIRED") {
    return "bg-danger";
  }

  if (scanning) {
    return "bg-accent animate-glow-pulse";
  }

  return "bg-success";
}

export function PiCameraPanel({
  capture,
  scanning,
  onScan,
}: PiCameraPanelProps) {
  const status = getStatusText(capture);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-elevated">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Raspberry Pi Camera</p>

          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
            warehouse-camera-01
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          <span
            className={`h-2 w-2 rounded-full ${statusTone(capture, scanning)}`}
          />

          {capture?.status ?? "READY"}
        </div>
      </div>

      {capture?.evidenceUrl && (
        <div className="relative aspect-video w-full overflow-hidden bg-black/40">
          <Image
            src={capture.evidenceUrl}
            alt="Raspberry Pi camera capture"
            fill
            unoptimized
            className="object-contain"
          />
        </div>
      )}

      <div className="px-4 py-5">
        <div className="flex items-start gap-3">
          {scanning && (
            <div className="mt-0.5 h-4 w-4 shrink-0 animate-spin-slow rounded-full border-2 border-line border-t-accent" />
          )}

          <div>
            <p className="text-sm font-medium text-ink">{status.title}</p>

            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              {status.detail}
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end border-t border-line px-4 py-3">
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className="rounded-lg bg-accent px-5 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent-2 disabled:pointer-events-none disabled:opacity-40"
        >
          {scanning ? "Scanning…" : "Scan Part"}
        </button>
      </div>
    </div>
  );
}
