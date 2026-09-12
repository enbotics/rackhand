import logging
import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .client import WarehouseServerClient


logger = logging.getLogger(__name__)


class DeviceHealthReporter:
    """Report Pi health independently from queue and capture requests."""

    def __init__(
        self,
        client: "WarehouseServerClient",
        interval_seconds: float,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("DEVICE_HEARTBEAT_SECONDS must be positive")
        self.client = client
        self.interval_seconds = interval_seconds
        self.worker_started_at = datetime.now(timezone.utc).isoformat()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._payload = {
            "workerState": "STARTING",
            "cameraReady": False,
            "previewReady": False,
            "activeJobId": None,
            "cpuTemperatureC": None,
            "cpuLoadPercent": None,
            "memoryUsedPercent": None,
            "workerVersion": "warehouse-camera-1",
            "workerStartedAt": self.worker_started_at,
            "lastError": None,
        }

    def update(
        self,
        worker_state: str,
        *,
        camera_ready: bool,
        preview_ready: bool,
        active_job_id: Optional[str] = None,
        last_error: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._payload.update(
                {
                    "workerState": worker_state,
                    "cameraReady": camera_ready,
                    "previewReady": preview_ready,
                    "activeJobId": active_job_id,
                    "lastError": last_error[:500] if last_error else None,
                }
            )
        self._wake.set()

    def send_now(self) -> None:
        with self._lock:
            payload = dict(self._payload)
        try:
            self.client.report_device_health(payload)
        except Exception as error:
            # Health is observational. It must never fail or delay a capture.
            logger.warning("Could not report camera device health: %s", error)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.send_now()
            self._wake.wait(self.interval_seconds)
            self._wake.clear()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run,
            name="device-health",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self.update(
            "STOPPING",
            camera_ready=False,
            preview_ready=False,
        )
        self.send_now()
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=1)
