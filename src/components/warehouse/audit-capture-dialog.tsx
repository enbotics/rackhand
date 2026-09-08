"use client";

import { useEffect, useRef, useState } from "react";
import type { Shot } from "@/lib/shots-db";
import { Modal } from "./modal";
import { BUTTON_VARIANTS, ErrorNote } from "./ui";

interface PendingCapture {
  captureId: string;
  binCode: string;
}

/**
 * The operator-visible replacement for the old silent AuditCameraBridge.
 *
 * Same server contract (poll for a pending capture, upload the frame to the
 * same capture id) — the only thing that changed is that submitting the
 * frame is now a deliberate click on a live preview, matching the guided
 * putaway placement-verification dialog's shape, instead of an invisible
 * background grab the operator had no part in.
 */
export function AuditCaptureDialog({
  captureFrame,
  getCameraStream,
}: {
  captureFrame: () => Shot | null;
  getCameraStream: () => MediaStream | null;
}) {
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        // Never interrupt a capture already being submitted or reviewed —
        // only look for a NEW one once this one is fully closed out.
        if (!submitting && result === null) {
          const response = await fetch("/api/warehouse/audits/captures/pending", { cache: "no-store" });
          const data = response.ok
            ? ((await response.json()) as { captureId: string | null; binCode?: string })
            : null;
          if (!stopped && data?.captureId && data.captureId !== handledId.current) {
            setPending({ captureId: data.captureId, binCode: data.binCode ?? "bin" });
            setError(null);
          } else if (!stopped && !data?.captureId) {
            setPending(null);
          }
        }
      } catch {
        // The rest of the app stays usable when this optional poll misses.
      }
      if (!stopped) timer = setTimeout(poll, 1_000);
    };
    timer = setTimeout(poll, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [submitting, result]);

  useEffect(() => {
    if (!pending) return;
    const video = videoRef.current;
    if (video) video.srcObject = getCameraStream();
  }, [pending, getCameraStream]);

  async function capture() {
    if (!pending) return;
    const shot = captureFrame();
    if (!shot) {
      setError("The camera is not ready. Start the live camera, then retry.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/warehouse/audits/captures/${pending.captureId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: shot.dataUrl,
          imageWidth: shot.width,
          imageHeight: shot.height,
        }),
      });
      handledId.current = pending.captureId;
      setResult(response.ok ? "success" : "failure");
    } catch {
      handledId.current = pending.captureId;
      setResult("failure");
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setPending(null);
    setResult(null);
    setError(null);
  }

  if (!pending) return null;

  return (
    <Modal
      title={`Auditing ${pending.binCode}`}
      onClose={close}
      dismissible={!submitting}
      maxWidthClassName="max-w-2xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-ink">
          The gantry has presented <strong>{pending.binCode}</strong> for a physical inventory
          check. Line it up in the frame below, then capture.
        </p>

        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black/40">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-cover"
          />
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {result === null && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void capture()}
              disabled={submitting}
              className={BUTTON_VARIANTS.approve}
            >
              {submitting ? "Analyzing…" : "Capture & Analyze"}
            </button>
          </div>
        )}

        {result === "success" && (
          <div className="rounded-xl border border-success/40 bg-success-soft p-4 text-success">
            <p className="font-semibold">Image captured</p>
            <p className="mt-1 text-xs leading-relaxed">
              The frame was analyzed and the bin is being returned to the shelf. Full results
              appear in the Inventory Auditor panel.
            </p>
          </div>
        )}

        {result === "failure" && (
          <div className="rounded-xl border border-danger/40 bg-danger-soft p-4 text-danger">
            <p className="font-semibold">Capture failed</p>
            <p className="mt-1 text-xs leading-relaxed">
              The bin will still be returned to the shelf; this audit is flagged for review.
            </p>
          </div>
        )}

        {result !== null && (
          <div className="flex justify-end">
            <button type="button" onClick={close} className={BUTTON_VARIANTS.secondary}>
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
