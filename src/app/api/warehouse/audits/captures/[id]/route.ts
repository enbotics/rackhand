import { NextResponse } from "next/server";
import { prisma } from "@/lib/warehouse/db";
import { countAuditImage } from "@/lib/geminiAuditCount";
import { uploadAuditEvidence } from "@/lib/warehouse/storage";
import { classifyAndPersistAuditCapture } from "@/lib/warehouse/audit-bin-service";
import type { AuditCaptureOutcome, AuditCaptureView } from "@/lib/warehouse/audit-capture-types";
import { confidencePercent } from "@/lib/warehouse/audit-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** UNEXPECTED_STOCK has no confirmable comparison — it never reaches this view. */
const DISPLAY_OUTCOME: Record<AuditCaptureOutcome | "UNEXPECTED_STOCK", AuditCaptureOutcome> = {
  VERIFIED: "VERIFIED",
  AUTO_RECONCILED: "AUTO_RECONCILED",
  REVIEW_DECREASE: "REVIEW_DECREASE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  FOREIGN_OBJECTS: "FOREIGN_OBJECTS",
  UNEXPECTED_STOCK: "LOW_CONFIDENCE",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "malformed_request",
          message: "Body is not valid JSON.",
        },
      },
      { status: 400 },
    );
  }
  const input = body as {
    imageDataUrl?: unknown;
    imageWidth?: unknown;
    imageHeight?: unknown;
  };
  if (
    typeof input.imageDataUrl !== "string" ||
    !/^data:image\/[a-z0-9.+-]+;base64,/i.test(input.imageDataUrl) ||
    input.imageDataUrl.length > 7_000_000 ||
    !Number.isInteger(input.imageWidth) ||
    !Number.isInteger(input.imageHeight) ||
    Number(input.imageWidth) <= 0 ||
    Number(input.imageHeight) <= 0
  ) {
    return NextResponse.json(
      {
        error: {
          code: "validation_failed",
          message: "A valid camera image and dimensions are required.",
        },
      },
      { status: 422 },
    );
  }

  const claimed = await prisma.auditCaptureRequest.updateMany({
    where: { id, status: "WAITING_FOR_CAMERA", expiresAt: { gt: new Date() } },
    data: { status: "CAPTURING" },
  });
  if (claimed.count !== 1) {
    return NextResponse.json(
      {
        error: {
          code: "capture_not_pending",
          message: "This audit capture is no longer pending.",
        },
      },
      { status: 409 },
    );
  }

  let evidenceUrl: string | null = null;
  let binAuditId: string | null = null;
  try {
    const capture = await prisma.auditCaptureRequest.findUniqueOrThrow({
      where: { id },
      include: {
        binAudit: {
          include: { bin: true, auditRun: true, expectedPart: true },
        },
      },
    });
    binAuditId = capture.binAuditId;
    const { binAudit } = capture;
    // A stale/superseded attempt (superseded by a retry that reset this same
    // row) must never write a photo taken for a different attempt.
    const imageBuffer = Buffer.from(
      input.imageDataUrl.slice(input.imageDataUrl.indexOf(",") + 1),
      "base64",
    );
    evidenceUrl = await uploadAuditEvidence(
      binAudit.auditRunId,
      `${binAudit.id}-attempt${capture.attempt}`,
      binAudit.bin.code,
      input.imageDataUrl,
    );
    const part = binAudit.expectedPart;
    const vision = await countAuditImage(imageBuffer, {
      binCode: binAudit.bin.code,
      sku: part?.sku ?? null,
      canonicalName: part?.canonicalName ?? null,
      dimensions: part
        ? {
            lengthMM: part.lengthMM,
            widthMM: part.widthMM,
            heightMM: part.heightMM,
          }
        : null,
    });

    const { outcome, status } = await classifyAndPersistAuditCapture({
      captureId: id,
      binAuditId: binAudit.id,
      binId: binAudit.binId,
      binCode: binAudit.bin.code,
      originalStatus: binAudit.bin.status,
      expectedPartId: binAudit.expectedPartId,
      expectedQuantity: capture.expectedQuantity,
      capacity: binAudit.bin.capacity,
      vision,
      evidenceUrl,
    });
    await prisma.auditCaptureRequest.update({
      where: { id },
      data: { imageWidth: Number(input.imageWidth), imageHeight: Number(input.imageHeight) },
    });

    const view: AuditCaptureView = {
      captureId: id,
      binCode: binAudit.bin.code,
      status,
      outcome: DISPLAY_OUTCOME[outcome],
      expectedQuantity: capture.expectedQuantity,
      observedQuantity: vision.observedCount,
      confidencePercent: confidencePercent(vision.countConfidence),
      previousImageUrl: capture.previousImageUrl,
      currentImageUrl: evidenceUrl,
      foreignObjects: vision.foreignObjects ?? [],
      notes:
        outcome === "UNEXPECTED_STOCK"
          ? `${vision.notes} No catalog record expects stock in this bin — resolve it from bin management, not this capture.`.trim()
          : vision.notes,
    };
    return NextResponse.json(view);
  } catch (error) {
    console.error(`[inventory-audit] capture failed id=${id}`, error);
    await prisma.auditCaptureRequest
      .update({
        where: { id },
        data: {
          status: "FAILED",
          evidenceUrl,
          errorCode:
            error instanceof Error && error.message === "audit_vision_invalid"
              ? "audit_vision_invalid"
              : "capture_failed",
        },
      })
      .catch(() => {});
    if (evidenceUrl && binAuditId) {
      await prisma.binAudit
        .update({
          where: { id: binAuditId },
          data: { evidenceUrl, capturedAt: new Date() },
        })
        .catch(() => {});
    }
    return NextResponse.json(
      {
        error: {
          code: "capture_failed",
          message: "The audit image could not be processed.",
        },
      },
      { status: 500 },
    );
  }
}
