import io
import json
import logging
import threading
import time
from http import server
from pathlib import Path
from socketserver import ThreadingMixIn

from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput

from .config import Settings


logger = logging.getLogger(__name__)


class StreamingOutput(io.BufferedIOBase):
    def __init__(self) -> None:
        self.frame: bytes | None = None
        self.condition = threading.Condition()

    def write(self, buffer: bytes) -> int:
        with self.condition:
            self.frame = bytes(buffer)
            self.condition.notify_all()
        return len(buffer)


class PreviewServer(ThreadingMixIn, server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def preview_handler(output: StreamingOutput):
    class PreviewHandler(server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/health":
                body = json.dumps({"ok": True, "camera": "warehouse-camera-01"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path != "/stream.mjpg":
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Age", "0")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=FRAME")
            self.end_headers()
            previous: bytes | None = None
            try:
                while True:
                    with output.condition:
                        output.condition.wait_for(
                            lambda: output.frame is not None and output.frame is not previous,
                            timeout=5,
                        )
                        frame = output.frame
                    if frame is None or frame is previous:
                        continue
                    previous = frame
                    self.wfile.write(b"--FRAME\r\n")
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(frame)))
                    self.end_headers()
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, format: str, *args) -> None:
            logger.debug("Preview client: " + format, *args)

    return PreviewHandler


class WarehouseCamera:
    """One Picamera2 owner shared by live preview and evidence captures."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.camera = Picamera2()
        self.output = StreamingOutput()
        self.encoder = MJPEGEncoder()
        self.capture_lock = threading.Lock()
        self.httpd: PreviewServer | None = None
        self.server_thread: threading.Thread | None = None
        self.started = False

    def start(self) -> None:
        if self.started:
            return
        logger.info(
            "Initializing full-res %sx%s capture with %sx%s@%sfps preview",
            self.settings.camera_width,
            self.settings.camera_height,
            self.settings.preview_width,
            self.settings.preview_height,
            self.settings.preview_fps,
        )
        config = self.camera.create_video_configuration(
            main={
                "size": (self.settings.camera_width, self.settings.camera_height),
                "format": "RGB888",
            },
            lores={
                "size": (self.settings.preview_width, self.settings.preview_height),
                "format": "YUV420",
            },
            controls={"FrameRate": self.settings.preview_fps},
            display=None,
            encode="lores",
            buffer_count=4,
        )
        self.camera.configure(config)
        self.camera.start_recording(
            self.encoder,
            FileOutput(self.output),
            name="lores",
        )
        time.sleep(self.settings.camera_settle_seconds)

        self.httpd = PreviewServer(
            ("0.0.0.0", self.settings.preview_port),
            preview_handler(self.output),
        )
        self.server_thread = threading.Thread(
            target=self.httpd.serve_forever,
            name="camera-preview",
            daemon=True,
        )
        self.server_thread.start()
        self.started = True
        logger.info("Live preview ready on port %s", self.settings.preview_port)

    def autofocus(self) -> bool:
        if not self.started:
            raise RuntimeError("Camera is not started")
        logger.info("Running autofocus")
        try:
            result = self.camera.autofocus_cycle()
            logger.info("Autofocus result: %s", result)
            return bool(result)
        except Exception:
            logger.exception("Autofocus failed")
            return False

    def capture(self, output_path: Path) -> Path:
        if not self.started:
            raise RuntimeError("Camera is not started")
        with self.capture_lock:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            if not self.autofocus():
                raise RuntimeError("camera_focus_failed")
            logger.info("Capturing full-resolution evidence: %s", output_path)
            self.camera.capture_file(str(output_path), name="main")
            if not output_path.exists() or output_path.stat().st_size <= 0:
                raise RuntimeError("camera_capture_empty")
            logger.info("Image captured: %s bytes", output_path.stat().st_size)
            return output_path

    def close(self) -> None:
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
        if self.started:
            logger.info("Stopping camera and live preview")
            try:
                self.camera.stop_recording()
            finally:
                self.started = False
