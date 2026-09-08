"use client";

import { useEffect, useRef, useState } from "react";
import { useSharedCamera } from "@/lib/camera-context";
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
 *
 * MOUNTED AT THE LAYOUT, not on a page. An audit is almost always started
 * from the Warehouse Agent chat on the landing page; requiring the operator
 * to notice that and walk over to /scan is how audits ended up dying with
 * `capture_station_unavailable`. It reads the one shared camera directly
 * (lib/camera-context.tsx) rather than taking callbacks from whichever page
 * happens to own a CameraStage.
 */
export function AuditCaptureDialog() {
  const camera = useSharedCamera();
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handledId = useRef<string | null>(null);
  const autoStartedFor = useRef<string | null>(null);

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

  /**
   * Lazily open the camera the moment the warehouse actually needs it, so a
   * long-lived tab that never visited /scan is not a dead end. Attempted once
   * per capture request: Chrome will show its permission prompt without a
   * gesture, Safari will not, so the dialog ALWAYS renders a manual "Start
   * camera" button below when this does not take — an empty black box with no
   * way out was the original complaint.
   */
  useEffect(() => {
    if (!pending || camera.status !== "idle") return;
    if (autoStartedFor.current === pending.captureId) return;
    autoStartedFor.current = pending.captureId;
    void camera.start();
  }, [camera, pending]);

  useEffect(() => {
    if (!pending) return;
    const video = videoRef.current;
    // The one live stream already open for scanning, in a second read-only
    // preview — never a second camera device.
    if (video) video.srcObject = camera.getStream();
  }, [pending, camera]);

  async function capture() {
    if (!pending) return;
    const shot = camera.captureFrame();
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

  const live = camera.status === "live";

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
          {live ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full object-cover ${camera.mirrored ? "-scale-x-100" : ""}`}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              {camera.status === "requesting" ? (
                <>
                  <div className="animate-spin-slow h-7 w-7 rounded-full border-2 border-line border-t-accent" />
                  <p className="text-xs text-ink-muted">Opening the overhead camera…</p>
                </>
              ) : (
                <>
                  <p className="max-w-sm text-xs leading-relaxed text-ink-muted">
                    {camera.errorMessage ??
                      "The overhead camera is not running yet."}
                    {camera.status === "denied" &&
                      " Allow camera access for this site in the browser address bar, then try again."}
                  </p>
                  <p className="max-w-sm text-[11px] leading-relaxed text-ink-faint">
                    Frames are measured server-side and never leave this machine.
                  </p>
                  <button
                    type="button"
                    onClick={() => void camera.start()}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-bg transition-colors hover:bg-accent-2"
                  >
                    {camera.status === "idle" ? "Start camera" : "Try again"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {result === null && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void capture()}
              disabled={submitting || !live}
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
