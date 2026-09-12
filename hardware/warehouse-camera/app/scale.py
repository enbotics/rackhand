import logging
import re
import time
from collections import deque
from statistics import mean

from .config import Settings


logger = logging.getLogger(__name__)

WEIGHT_PATTERN = re.compile(
    r"(?P<value>[-+]?\d+(?:\.\d+)?)\s*(?P<unit>kg|g|lb|lbs|oz)?",
    re.IGNORECASE,
)

UNIT_TO_GRAMS = {
    "g": 1.0,
    "kg": 1000.0,
    "lb": 453.59237,
    "lbs": 453.59237,
    "oz": 28.349523125,
}


class ScaleReadError(RuntimeError):
    pass


def parse_weight_grams(line: str, default_unit: str = "g") -> float:
    """Parse common streaming serial-scale output into grams."""
    matches = list(WEIGHT_PATTERN.finditer(line))
    if not matches:
        raise ScaleReadError(f"Scale returned no numeric weight: {line!r}")

    # Prefer a number with an explicit unit. Status prefixes sometimes contain
    # unrelated digits, so the right-most weight token is the safest fallback.
    match = next(
        (candidate for candidate in reversed(matches) if candidate.group("unit")),
        matches[-1],
    )
    unit = (match.group("unit") or default_unit).lower()
    factor = UNIT_TO_GRAMS.get(unit)
    if factor is None:
        raise ScaleReadError(f"Unsupported scale unit: {unit}")

    value = float(match.group("value")) * factor
    if value <= 0:
        raise ScaleReadError("Scale weight must be positive.")
    return value


class UsbScale:
    """Read a stable weight from a USB scale exposed as a serial device."""

    def __init__(self, settings: Settings):
        self.settings = settings
        if settings.scale_unit not in UNIT_TO_GRAMS:
            raise ScaleReadError(
                f"SCALE_UNIT must be one of: {', '.join(UNIT_TO_GRAMS)}"
            )
        if settings.scale_stable_samples < 1:
            raise ScaleReadError("SCALE_STABLE_SAMPLES must be at least 1.")
        if settings.scale_stability_tolerance_grams < 0:
            raise ScaleReadError(
                "SCALE_STABILITY_TOLERANCE_GRAMS must be non-negative."
            )

    def read_stable_grams(self) -> float:
        try:
            import serial
        except ImportError as error:
            raise ScaleReadError(
                "pyserial is not installed; install hardware/warehouse-camera/requirements.txt"
            ) from error

        deadline = time.monotonic() + self.settings.scale_read_timeout_seconds
        samples: deque[float] = deque(maxlen=self.settings.scale_stable_samples)
        logger.info("Reading USB scale on %s", self.settings.scale_serial_port)

        try:
            with serial.Serial(
                port=self.settings.scale_serial_port,
                baudrate=self.settings.scale_baud_rate,
                timeout=min(self.settings.scale_read_timeout_seconds, 1.0),
            ) as device:
                device.reset_input_buffer()
                while time.monotonic() < deadline:
                    raw_line = device.readline()
                    if not raw_line:
                        continue
                    try:
                        value = parse_weight_grams(
                            raw_line.decode("ascii", errors="ignore"),
                            self.settings.scale_unit,
                        )
                    except ScaleReadError:
                        logger.debug("Ignoring unparseable scale line: %r", raw_line)
                        continue

                    samples.append(value)
                    if (
                        len(samples) == self.settings.scale_stable_samples
                        and max(samples) - min(samples)
                        <= self.settings.scale_stability_tolerance_grams
                    ):
                        stable = round(mean(samples), 3)
                        logger.info("Stable scale reading: %.3f g", stable)
                        return stable
        except OSError as error:
            raise ScaleReadError(
                f"Unable to read scale at {self.settings.scale_serial_port}: {error}"
            ) from error

        raise ScaleReadError(
            "The scale did not provide a stable positive reading before timeout."
        )
