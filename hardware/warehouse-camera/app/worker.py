import json
import logging
import re
import signal
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from .camera import WarehouseCamera
from .client import WarehouseServerClient
from .config import load_settings
from .scale import ScaleReadError, UsbScale


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("warehouse-camera-worker")
running = True


def handle_shutdown(signum, frame) -> None:
    del signum, frame
    global running
    logger.info("Shutdown requested")
    running = False


signal.signal(signal.SIGTERM, handle_shutdown)
signal.signal(signal.SIGINT, handle_shutdown)


def safe_job_id(job_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise ValueError("Invalid jobId")
    return job_id


def metadata_path(image_path: Path) -> Path:
    return image_path.with_suffix(".json")


def save_spool_metadata(image_path: Path, metadata: dict) -> None:
    metadata_path(image_path).write_text(json.dumps(metadata, indent=2))


def delete_spool_files(image_path: Path) -> None:
    image_path.unlink(missing_ok=True)
    metadata_path(image_path).unlink(missing_ok=True)


def process_existing_spool(client: WarehouseServerClient, settings) -> None:
    """Retry captured evidence after a disconnect without taking a new photo."""
    for image_path in sorted(settings.spool_dir.glob("*.jpg")):
        meta_path = metadata_path(image_path)
        if not meta_path.exists():
            logger.warning("Ignoring spool image without metadata: %s", image_path)
            continue
        try:
            metadata = json.loads(meta_path.read_text())
            logger.info("Retrying pending upload for job %s", metadata["jobId"])
            if (
                metadata.get("purpose") == "PUTAWAY_VERIFICATION"
                and metadata.get("totalWeightGrams") is None
            ):
                metadata["totalWeightGrams"] = settings.scale_fallback_weight_grams
                metadata["weightSource"] = "FALLBACK"
                save_spool_metadata(image_path, metadata)
                logger.warning(
                    "Spool frame has no scale reading; using configured %.3f g fallback",
                    settings.scale_fallback_weight_grams,
                )
            client.upload_image(
                job_id=metadata["jobId"],
                image_path=image_path,
                captured_at=metadata["capturedAt"],
                width=metadata["width"],
                height=metadata["height"],
                total_weight_grams=metadata.get("totalWeightGrams"),
                weight_source=metadata.get("weightSource"),
            )
            delete_spool_files(image_path)
        except requests.HTTPError as error:
            if error.response is not None and error.response.status_code in (409, 410):
                logger.warning("Discarding terminal spool job: %s", image_path.name)
                delete_spool_files(image_path)
                continue
            raise


def capture_job(
    job: dict,
    camera: WarehouseCamera,
    scale: UsbScale,
    client: WarehouseServerClient,
    settings,
) -> None:
    job_id = safe_job_id(job["jobId"])
    image_path = settings.spool_dir / f"{job_id}.jpg"
    stop_heartbeat = threading.Event()

    def heartbeat() -> None:
        while not stop_heartbeat.wait(settings.lease_heartbeat_seconds):
            try:
                client.renew_lease(job_id)
            except Exception:
                logger.warning("Could not renew lease for job %s", job_id, exc_info=True)

    heartbeat_thread = threading.Thread(
        target=heartbeat,
        name=f"lease-{job_id[:8]}",
        daemon=True,
    )
    heartbeat_thread.start()
    try:
        if image_path.exists():
            meta_path = metadata_path(image_path)
            if not meta_path.exists():
                raise RuntimeError("Existing spool image has no metadata")
            metadata = json.loads(meta_path.read_text())
        else:
            logger.info(
                "Capturing job %s purpose=%s",
                job_id,
                job.get("purpose"),
            )
            total_weight_grams = None
            weight_source = None
            if job.get("purpose") == "PUTAWAY_VERIFICATION":
                # Read immediately before the evidence frame while the bin is
                # stationary on the scale. Both values are then spooled as one
                # durable physical observation.
                try:
                    total_weight_grams = scale.read_stable_grams()
                    weight_source = "SCALE"
                except ScaleReadError as error:
                    total_weight_grams = settings.scale_fallback_weight_grams
                    weight_source = "FALLBACK"
                    logger.warning(
                        "USB scale unavailable (%s); using configured %.3f g fallback",
                        error,
                        total_weight_grams,
                    )
            camera.capture(image_path)
            metadata = {
                "jobId": job_id,
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "width": settings.camera_width,
                "height": settings.camera_height,
                "purpose": job.get("purpose"),
                "totalWeightGrams": total_weight_grams,
                "weightSource": weight_source,
            }
            save_spool_metadata(image_path, metadata)

        client.upload_image(
            job_id=job_id,
            image_path=image_path,
            captured_at=metadata["capturedAt"],
            width=metadata["width"],
            height=metadata["height"],
            total_weight_grams=metadata.get("totalWeightGrams"),
            weight_source=metadata.get("weightSource"),
        )
        delete_spool_files(image_path)
        logger.info("Job %s uploaded successfully", job_id)
    finally:
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=1)


def drain_jobs(
    client: WarehouseServerClient,
    camera: WarehouseCamera,
    scale: UsbScale,
    settings,
) -> None:
    """Catch up durable jobs after one Realtime wake-up, then return to SSE."""
    process_existing_spool(client, settings)
    while running:
        job = client.get_next_job()
        if job is None:
            return
        try:
            capture_job(job, camera, scale, client, settings)
        except Exception as error:
            job_id = job.get("jobId")
            logger.exception("Capture job failed: %s", job_id)
            spool_image = settings.spool_dir / f"{safe_job_id(job_id)}.jpg"
            if not spool_image.exists():
                client.report_failure(
                    job_id=job_id,
                    error_code="camera_capture_failed",
                    error_message=str(error),
                )
            else:
                # An upload failure keeps the exact JPEG for the next wake or
                # reconnect. Never recapture a durable job.
                return


def run() -> None:
    settings = load_settings()
    if settings.scale_fallback_weight_grams <= 0:
        raise RuntimeError("SCALE_FALLBACK_WEIGHT_GRAMS must be positive")
    logger.info("Warehouse live camera starting device=%s", settings.device_id)
    logger.info("Server: %s", settings.server_base_url)
    camera = WarehouseCamera(settings)
    scale = UsbScale(settings)
    client = WarehouseServerClient(settings)
    camera.start()
    backoff_seconds = settings.reconnect_delay_seconds
    try:
        process_existing_spool(client, settings)
        while running:
            try:
                logger.info("Connecting to camera Realtime event stream")
                for should_drain in client.realtime_wakeups():
                    if not running:
                        break
                    if not should_drain:
                        continue
                    backoff_seconds = settings.reconnect_delay_seconds
                    logger.info("Realtime wake received; checking durable queue")
                    drain_jobs(client, camera, scale, settings)
                if running:
                    raise requests.ConnectionError("Camera Realtime stream ended")
            except requests.RequestException as error:
                if not running:
                    break
                logger.warning("Camera Realtime connection failed: %s", error)
                logger.info("Reconnecting in %.1f seconds", backoff_seconds)
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 30)
            except Exception:
                logger.exception("Unexpected worker error")
                time.sleep(settings.reconnect_delay_seconds)
    finally:
        camera.close()
        logger.info("Warehouse live camera stopped")


if __name__ == "__main__":
    run()
