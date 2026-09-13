import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

# Test the handshake with hardware and network interfaces replaced by test doubles.
with patch.dict(sys.modules, {
    "app.camera": SimpleNamespace(WarehouseCamera=Mock),
    "requests": SimpleNamespace(HTTPError=Exception, RequestException=Exception, ConnectionError=Exception),
}):
    worker = importlib.import_module("app.worker")


class RecordingClient:
    def __init__(self):
        self.uploads = []

    def renew_lease(self, job_id):
        pass

    def upload_image(self, job_id, image_path, captured_at, width, height,
                     total_weight_grams=None, weight_source=None):
        self.uploads.append((total_weight_grams, weight_source))


class AuditScaleCaptureTest(unittest.TestCase):
    def settings(self, directory):
        return SimpleNamespace(spool_dir=Path(directory), lease_heartbeat_seconds=30,
                               camera_width=640, camera_height=480, scale_fallback_weight_grams=150)

    def test_audit_and_recount_upload_the_real_scale_reading_with_the_frame(self):
        for purpose in ("INVENTORY_AUDIT", "RECOUNT"):
            with self.subTest(purpose=purpose), tempfile.TemporaryDirectory() as directory:
                camera = Mock()
                camera.capture.side_effect = lambda path: path.write_bytes(b"frame")
                scale = Mock()
                scale.read_stable_grams.return_value = 167
                client = RecordingClient()
                worker.capture_job({"jobId": "audit-test", "purpose": purpose}, camera, scale,
                                   client, Mock(), self.settings(directory))
                scale.read_stable_grams.assert_called_once()
                camera.capture.assert_called_once()
                self.assertEqual(client.uploads, [(167, "SCALE")])

    def test_unavailable_scale_is_explicitly_labelled_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            camera = Mock()
            camera.capture.side_effect = lambda path: path.write_bytes(b"frame")
            client = RecordingClient()
            worker.capture_job({"jobId": "audit-test", "purpose": "INVENTORY_AUDIT"}, camera,
                               None, client, Mock(), self.settings(directory))
            self.assertEqual(client.uploads, [(150, "FALLBACK")])

    def test_upload_retry_reuses_the_original_frame_and_weight(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "audit-test.jpg"
            image.write_bytes(b"original frame")
            worker.save_spool_metadata(image, {"jobId": "audit-test", "purpose": "INVENTORY_AUDIT",
                "capturedAt": "2026-09-15T00:00:00Z", "width": 640, "height": 480,
                "totalWeightGrams": 167, "weightSource": "SCALE"})
            camera, scale, client = Mock(), Mock(), RecordingClient()
            worker.capture_job({"jobId": "audit-test", "purpose": "INVENTORY_AUDIT"}, camera, scale,
                               client, Mock(), self.settings(directory))
            camera.capture.assert_not_called()
            scale.read_stable_grams.assert_not_called()
            self.assertEqual(client.uploads, [(167, "SCALE")])
