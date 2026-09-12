import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PROJECT_ROOT / "camera.env"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(DEFAULT_ENV_FILE)


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc


def get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a number") from exc


def get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


@dataclass(frozen=True)
class Settings:
    server_base_url: str
    device_id: str
    device_token: str
    request_timeout_seconds: float
    reconnect_delay_seconds: float
    lease_heartbeat_seconds: float
    camera_width: int
    camera_height: int
    preview_width: int
    preview_height: int
    preview_fps: int
    preview_port: int
    autofocus_timeout_seconds: float
    camera_settle_seconds: float
    scale_enabled: bool
    scale_serial_port: str
    scale_baud_rate: int
    scale_unit: str
    scale_read_timeout_seconds: float
    scale_stable_samples: int
    scale_stability_tolerance_grams: float
    scale_fallback_weight_grams: float
    spool_dir: Path


def load_settings() -> Settings:
    spool_dir = Path(os.getenv("SPOOL_DIR", str(PROJECT_ROOT / "spool")))
    spool_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        server_base_url=require_env("SERVER_BASE_URL").rstrip("/"),
        device_id=require_env("CAMERA_DEVICE_ID"),
        device_token=require_env("CAMERA_DEVICE_TOKEN"),
        request_timeout_seconds=get_float("REQUEST_TIMEOUT_SECONDS", 15.0),
        reconnect_delay_seconds=get_float("REALTIME_RECONNECT_DELAY_SECONDS", 2.0),
        lease_heartbeat_seconds=get_float("LEASE_HEARTBEAT_SECONDS", 30.0),
        camera_width=get_int("CAMERA_WIDTH", 4608),
        camera_height=get_int("CAMERA_HEIGHT", 2592),
        preview_width=get_int("PREVIEW_WIDTH", 1280),
        preview_height=get_int("PREVIEW_HEIGHT", 720),
        preview_fps=get_int("PREVIEW_FPS", 15),
        preview_port=get_int("PREVIEW_PORT", 8000),
        autofocus_timeout_seconds=get_float("AUTOFOCUS_TIMEOUT_SECONDS", 8.0),
        camera_settle_seconds=get_float("CAMERA_SETTLE_SECONDS", 2.0),
        scale_enabled=get_bool("SCALE_ENABLED", True),
        scale_serial_port=os.getenv("SCALE_SERIAL_PORT", "/dev/ttyUSB0").strip(),
        scale_baud_rate=get_int("SCALE_BAUD_RATE", 19200),
        scale_unit=os.getenv("SCALE_UNIT", "g").strip().lower(),
        scale_read_timeout_seconds=get_float("SCALE_READ_TIMEOUT_SECONDS", 10.0),
        scale_stable_samples=get_int("SCALE_STABLE_SAMPLES", 3),
        scale_stability_tolerance_grams=get_float(
            "SCALE_STABILITY_TOLERANCE_GRAMS", 1.0
        ),
        scale_fallback_weight_grams=get_float("SCALE_FALLBACK_WEIGHT_GRAMS", 150.0),
        spool_dir=spool_dir,
    )
