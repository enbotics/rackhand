import { NextResponse } from "next/server";
import { authenticateCameraDevice } from "@/lib/camera/device-auth";
import {
  parseCameraDeviceHeartbeat,
  recordCameraDeviceHeartbeat,
} from "@/lib/camera/device-health-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = authenticateCameraDevice(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: "camera_unauthorized", message: "Invalid camera credentials." } },
      { status: 401 },
    );
  }
  try {
    const heartbeat = parseCameraDeviceHeartbeat(await request.json());
    await recordCameraDeviceHeartbeat(auth.deviceId, heartbeat);
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "camera_health_invalid",
          message: error instanceof Error ? error.message : "Camera health report is invalid.",
        },
      },
      { status: 422 },
    );
  }
}
