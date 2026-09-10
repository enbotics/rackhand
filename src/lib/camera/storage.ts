import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { createRealtimeAdminClient } from "@/lib/supabase/realtime-admin";

interface UploadCameraCaptureInput {
  jobId: string;
  imageBuffer: Buffer;
  mimeType: "image/jpeg";
}

const ROOT =
  process.env.CAMERA_CAPTURE_DIR ??
  path.join(process.cwd(), "data", "camera-captures");
const BUCKET =
  process.env.CAMERA_CAPTURE_BUCKET?.trim() || "warehouse-camera-captures";

const globalForStorage = globalThis as unknown as {
  warehouseCameraBucket?: Promise<void>;
};

function safeJobId(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== jobId) throw new Error("invalid_camera_job_id");
  return safe;
}

function objectPath(jobId: string): string {
  return `jobs/${safeJobId(jobId)}.jpg`;
}

async function ensureCaptureBucket(): Promise<void> {
  const client = createRealtimeAdminClient();
  const { data, error } = await client.storage.getBucket(BUCKET);
  if (data && !error) return;

  const { error: createError } = await client.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 12 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg"],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`camera_capture_bucket_unavailable: ${createError.message}`);
  }
}

async function captureBucket(): Promise<void> {
  let ready = globalForStorage.warehouseCameraBucket;
  if (!ready) {
    ready = ensureCaptureBucket().catch((error) => {
      globalForStorage.warehouseCameraBucket = undefined;
      throw error;
    });
    globalForStorage.warehouseCameraBucket = ready;
  }
  return ready;
}

export async function uploadCameraCapture(
  input: UploadCameraCaptureInput,
): Promise<string> {
  const jobId = safeJobId(input.jobId);
  await captureBucket();
  const client = createRealtimeAdminClient();
  const { error } = await client.storage
    .from(BUCKET)
    .upload(objectPath(jobId), input.imageBuffer, {
      contentType: input.mimeType,
      upsert: true,
    });
  if (error) throw new Error(`camera_evidence_upload_failed: ${error.message}`);
  return `/api/camera/captures/${jobId}/image`;
}

/** Reads durable evidence for comparison display or analysis retry. */
export async function readCameraCapture(jobId: string): Promise<Buffer> {
  const safe = safeJobId(jobId);
  try {
    await captureBucket();
    const client = createRealtimeAdminClient();
    const { data, error } = await client.storage
      .from(BUCKET)
      .download(objectPath(safe));
    if (!error && data) return Buffer.from(await data.arrayBuffer());
  } catch {
    // Evidence created before durable storage may still exist locally.
  }

  return fs.readFile(path.join(ROOT, `${safe}.jpg`));
}
