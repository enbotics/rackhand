import json
import logging
from pathlib import Path
from typing import Any, Iterator, Optional

import requests

from .config import Settings


logger = logging.getLogger(__name__)


class WarehouseServerClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.session = requests.Session()
        self.device_headers = {
            "Authorization": f"Bearer {settings.device_token}",
            "X-Camera-Device-Id": settings.device_id,
            "User-Agent": f"warehouse-camera/{settings.device_id}",
        }
        self.session.headers.update(self.device_headers)

    def realtime_wakeups(self) -> Iterator[bool]:
        """Yield event activity; True means the durable queue may have work."""
        url = f"{self.settings.server_base_url}/api/camera/device/events"
        with self.session.get(
            url,
            headers={"Accept": "text/event-stream"},
            stream=True,
            timeout=(self.settings.request_timeout_seconds, None),
        ) as response:
            response.raise_for_status()
            event_name: Optional[str] = None
            data_lines: list[str] = []
            # requests defaults to 512-byte chunks. SSE wake events are much
            # smaller, so that default can hold a valid wake in a client-side
            # buffer until after the capture lease ends.
            for raw_line in response.iter_lines(chunk_size=1, decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line.strip()
                if not line:
                    if event_name == "camera-job":
                        if data_lines:
                            json.loads("\n".join(data_lines))
                        yield True
                    else:
                        # Let the worker observe shutdown between SSE events.
                        # The server also emits an explicit camera-job wake on
                        # every heartbeat interval for durable queue polling.
                        yield False
                    event_name = None
                    data_lines = []
                elif line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())

    def get_next_job(self) -> Optional[dict[str, Any]]:
        response = self.session.get(
            f"{self.settings.server_base_url}/api/camera/device/jobs/next",
            timeout=self.settings.request_timeout_seconds,
        )
        if response.status_code == 204:
            return None
        response.raise_for_status()
        data = response.json()
        if not data.get("jobId"):
            raise RuntimeError("Server returned camera job without jobId")
        return data

    def renew_lease(self, job_id: str) -> None:
        # Keep lease heartbeats independent from the Session used by the main
        # upload thread; requests.Session is not guaranteed to be thread-safe.
        response = requests.post(
            f"{self.settings.server_base_url}/api/camera/device/jobs/{job_id}/lease",
            headers=self.device_headers,
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()

    def report_device_health(self, payload: dict[str, Any]) -> None:
        # Health reporting runs on its own thread. Do not share the main
        # requests.Session, which may be blocked reading the Realtime stream.
        response = requests.post(
            f"{self.settings.server_base_url}/api/camera/device/heartbeat",
            headers=self.device_headers,
            json=payload,
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()

    def upload_image(
        self,
        job_id: str,
        image_path: Path,
        captured_at: str,
        width: int,
        height: int,
        total_weight_grams: Optional[float] = None,
        weight_source: Optional[str] = None,
    ) -> dict[str, Any]:
        url = f"{self.settings.server_base_url}/api/camera/device/jobs/{job_id}/upload"
        logger.info("Uploading job %s (%s)", job_id, image_path)
        with image_path.open("rb") as image_file:
            fields = {
                "capturedAt": captured_at,
                "width": str(width),
                "height": str(height),
            }
            if total_weight_grams is not None:
                fields["totalWeightGrams"] = str(total_weight_grams)
            if weight_source is not None:
                fields["weightSource"] = weight_source
            response = self.session.post(
                url,
                files={"image": (image_path.name, image_file, "image/jpeg")},
                data=fields,
                timeout=max(self.settings.request_timeout_seconds, 60),
            )
        response.raise_for_status()
        return response.json()

    def report_failure(self, job_id: str, error_code: str, error_message: str) -> None:
        try:
            response = self.session.post(
                f"{self.settings.server_base_url}/api/camera/device/jobs/{job_id}/fail",
                json={"errorCode": error_code, "errorMessage": error_message[:500]},
                timeout=self.settings.request_timeout_seconds,
            )
            response.raise_for_status()
        except Exception:
            logger.exception("Unable to report failure for job %s", job_id)
