import { NextResponse } from "next/server";

import { authenticateCameraDevice } from "@/lib/camera/device-auth";
import { claimNextCaptureJob } from "@/lib/camera/capture-job-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = authenticateCameraDevice(request);

    if (!auth.ok) {
      return NextResponse.json(
        {
          error: {
            code: "camera_unauthorized",
            message: "Invalid camera credentials.",
          },
        },
        {
          status: 401,
        },
      );
    }

    const job = await claimNextCaptureJob(auth.deviceId);

    if (!job) {
      return new Response(null, {
        status: 204,
      });
    }

    return NextResponse.json({
      jobId: job.id,
      purpose: job.purpose,
      requestedAt: job.requestedAt.toISOString(),
      expiresAt: job.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[camera] Failed to claim next job:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_internal_error",
          message: "Could not retrieve the next camera job.",
        },
      },
      {
        status: 500,
      },
    );
  }
}
