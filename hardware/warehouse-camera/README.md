# Warehouse Pi camera

One `Picamera2` process owns Camera Module 3 NoIR for both:

- a `1280x720` MJPEG preview at `/stream.mjpg`;
- full-resolution evidence captures uploaded for durable camera jobs.

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
