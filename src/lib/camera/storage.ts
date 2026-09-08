import fs from "node:fs/promises";
import path from "node:path";

interface UploadCameraCaptureInput {
  jobId: string;
  imageBuffer: Buffer;
  mimeType: "image/jpeg";
}

const ROOT =
  process.env.CAMERA_CAPTURE_DIR ??
  path.join(process.cwd(), "data", "camera-captures");

export async function uploadCameraCapture(
  input: UploadCameraCaptureInput,
): Promise<string> {
  await fs.mkdir(ROOT, {
    recursive: true,
  });

  const safeJobId = input.jobId.replace(/[^a-zA-Z0-9_-]/g, "");

  if (!safeJobId) {
    throw new Error("invalid_camera_job_id");
  }

  const filename = `${safeJobId}.jpg`;

  const filepath = path.join(ROOT, filename);

  await fs.writeFile(filepath, input.imageBuffer);

  return `/api/camera/captures/${safeJobId}/image`;
}
