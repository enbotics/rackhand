import { NextResponse } from "next/server";

import { createCaptureJob } from "@/lib/camera/capture-job-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const job = await createCaptureJob({
      purpose: "MANUAL_SCAN",
    });

    return NextResponse.json(
      {
        captureJobId: job.id,
        status: job.status,
        requestedAt: job.requestedAt.toISOString(),
        expiresAt: job.expiresAt?.toISOString() ?? null,
      },
      {
        status: 201,
      },
    );
  } catch (error) {
    console.error("[camera] Failed to create capture job:", error);

    return NextResponse.json(
      {
        error: {
          code: "camera_job_create_failed",
          message: "Could not create a camera capture request.",
        },
      },
      {
        status: 500,
      },
    );
  }
}
