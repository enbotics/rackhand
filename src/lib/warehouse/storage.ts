import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface ParsedImage {
  buffer: Buffer;
  extension: string;
}

function safeSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

  if (!sanitized) {
    throw new Error("invalid_storage_identifier");
  }

  return sanitized;
}

function parseImageDataUrl(imageDataUrl: string): ParsedImage {
  const match = imageDataUrl.match(
    /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i,
  );

  if (!match) {
    throw new Error("invalid_image_data_url");
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2];

  const buffer = Buffer.from(base64, "base64");

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("invalid_image_size");
  }

  let extension: string;

  switch (mimeType) {
    case "image/jpeg":
      extension = "jpg";
      break;

    case "image/png":
      extension = "png";
      break;

    case "image/webp":
      extension = "webp";
      break;

    default:
      throw new Error("unsupported_image_type");
  }

  return {
    buffer,
    extension,
  };
}

/**
 * Root used for runtime warehouse evidence.
 *
 * Because this project is self-hosted with Next.js/PM2,
 * public/warehouse-evidence is sufficient for the MVP.
 *
 * Returned URLs are directly browser-accessible.
 */
function evidenceRoot(): string {
  return path.join(process.cwd(), "public", "warehouse-evidence");
}

/**
 * Stores the camera photo associated with a putaway.
 *
 * Called by:
 *   src/lib/warehouse/putaway-service.ts
 */
export async function uploadPutawayPhoto(
  scanId: string,
  imageDataUrl: string,
): Promise<string> {
  const safeScanId = safeSegment(scanId);

  const image = parseImageDataUrl(imageDataUrl);

  const relativeDirectory = path.join("putaway", safeScanId);

  const directory = path.join(evidenceRoot(), relativeDirectory);

  await mkdir(directory, {
    recursive: true,
  });

  const fileName = `evidence.${image.extension}`;

  const absolutePath = path.join(directory, fileName);

  await writeFile(absolutePath, image.buffer);

  return `/warehouse-evidence/putaway/${encodeURIComponent(
    safeScanId,
  )}/${fileName}`;
}

/**
 * Stores evidence captured during an inventory audit.
 *
 * Called by:
 *   POST /api/warehouse/audits/captures/[id]
 */
export async function uploadAuditEvidence(
  auditRunId: string,
  binAuditId: string,
  binCode: string,
  imageDataUrl: string,
): Promise<string> {
  const safeAuditRunId = safeSegment(auditRunId);

  const safeBinAuditId = safeSegment(binAuditId);

  const safeBinCode = safeSegment(binCode);

  const image = parseImageDataUrl(imageDataUrl);

  const relativeDirectory = path.join("audits", safeAuditRunId);

  const directory = path.join(evidenceRoot(), relativeDirectory);

  await mkdir(directory, {
    recursive: true,
  });

  const fileName = `${safeBinCode}-${safeBinAuditId}.${image.extension}`;

  const absolutePath = path.join(directory, fileName);

  await writeFile(absolutePath, image.buffer);

  return `/warehouse-evidence/audits/${encodeURIComponent(
    safeAuditRunId,
  )}/${fileName}`;
}
