import crypto from "node:crypto";

export type CameraDeviceAuth =
  | {
      ok: true;
      deviceId: string;
    }
  | {
      ok: false;
      reason: "missing_credentials" | "invalid_credentials";
    };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function authenticateCameraDevice(request: Request): CameraDeviceAuth {
  const expectedDeviceId = process.env.CAMERA_DEVICE_ID;

  const expectedToken = process.env.CAMERA_DEVICE_TOKEN;

  if (!expectedDeviceId || !expectedToken) {
    throw new Error("Camera device authentication is not configured");
  }

  const deviceId = request.headers.get("x-camera-device-id");

  const authorization = request.headers.get("authorization");

  if (!deviceId || !authorization?.startsWith("Bearer ")) {
    return {
      ok: false,
      reason: "missing_credentials",
    };
  }

  const token = authorization.slice(7);

  if (
    !safeEqual(deviceId, expectedDeviceId) ||
    !safeEqual(token, expectedToken)
  ) {
    return {
      ok: false,
      reason: "invalid_credentials",
    };
  }

  return {
    ok: true,
    deviceId,
  };
}
