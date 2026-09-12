# Warehouse Pi camera

One `Picamera2` process owns Camera Module 3 NoIR for both:

- a `1280x720` MJPEG preview at `/stream.mjpg`;
- full-resolution evidence captures uploaded for durable camera jobs.
- a stable USB serial-scale reading attached to every physical putaway photo.

The worker holds an authenticated SSE connection to the Next.js app. Supabase
Realtime wakes that connection when `CameraCaptureJob` is inserted. On every
connect/wake, the worker calls the existing atomic claim endpoint once and
drains any durable backlog. The server also sends an explicit periodic wake,
so a missed Realtime notification self-heals without requiring a reconnect.
Realtime messages therefore improve latency but never become warehouse truth.

Queued jobs do not expire during normal operator/network delays. After the Pi
claims a job it renews a short ownership lease until the full-resolution JPEG
is uploaded; server-side analysis separately renews its own processing lease.
A retry carries a workflow attempt number, so late evidence from an older
attempt is rejected safely.

Install `warehouse-camera.service` as `/etc/systemd/system/warehouse-camera.service`
and keep the real `camera.env` only on the Pi.

## USB scale

The worker expects a scale that appears as a serial device and continuously
prints a numeric weight such as `234.5 g` or `0.234 kg`. Configure its device
path and serial format in `camera.env`:

```env
SCALE_ENABLED=true
SCALE_SERIAL_PORT=/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG011UWY-if00-port0
SCALE_BAUD_RATE=19200
SCALE_UNIT=g
SCALE_READ_TIMEOUT_SECONDS=10
SCALE_STABLE_SAMPLES=3
SCALE_STABILITY_TOLERANCE_GRAMS=1
SCALE_FALLBACK_WEIGHT_GRAMS=150
```

The device path starts with `/dev`, not `/pi`. On the camera-only Raspberry Pi,
disable serial access explicitly:

```env
SCALE_ENABLED=false
SCALE_FALLBACK_WEIGHT_GRAMS=150
```

With `SCALE_ENABLED=false`, the worker does not attempt to open a serial port;
the photo workflow continues normally and uploads the configured fallback total.

Install dependencies and grant the service user serial-port access:

```bash
python3 -m pip install -r requirements.txt
sudo usermod -aG dialout pi
sudo systemctl restart warehouse-camera.service
```

`SCALE_UNIT` is used only when the scale sends a number without a unit. The
server subtracts `PUTAWAY_CONTAINER_TARE_GRAMS` (117 g by default), then divides
the net weight by the camera-confirmed quantity. If the scale presents itself
as a USB HID device instead of a serial port, a model-specific HID reader is
required.

If the serial scale is disconnected, unreadable or unstable, capture continues
with `SCALE_FALLBACK_WEIGHT_GRAMS` as the gross total. The database and UI mark
that value as `FALLBACK`; it is never represented as a physical scale reading.
