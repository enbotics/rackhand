import { NextResponse } from "next/server";
import { authenticateCameraDevice } from "@/lib/camera/device-auth";
import {
  CameraCaptureJobError,
  renewDeviceCaptureLease,
} from "@/lib/camera/capture-job-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = authenticateCameraDevice(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: "camera_unauthorized", message: "Invalid camera credentials." } },
      { status: 401 },
    );
  }

  try {
    const { id } = await context.params;
    const renewed = await renewDeviceCaptureLease(id, auth.deviceId);
    return NextResponse.json({ ok: true, renewed });
  } catch (error) {
    if (error instanceof CameraCaptureJobError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "camera_job_not_found" ? 404 : 409 },
      );
    }
    throw error;
  }
}
