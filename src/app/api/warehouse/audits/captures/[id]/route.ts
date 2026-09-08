import { NextResponse } from "next/server";
import { prisma } from "@/lib/warehouse/db";
import { countAuditImage } from "@/lib/geminiAuditCount";
import { uploadAuditEvidence } from "@/lib/warehouse/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "malformed_request", message: "Body is not valid JSON." } }, { status: 400 });
  }
  const input = body as { imageDataUrl?: unknown; imageWidth?: unknown; imageHeight?: unknown };
  if (
    typeof input.imageDataUrl !== "string" ||
    !/^data:image\/[a-z0-9.+-]+;base64,/i.test(input.imageDataUrl) ||
    input.imageDataUrl.length > 7_000_000 ||
    !Number.isInteger(input.imageWidth) ||
    !Number.isInteger(input.imageHeight) ||
    Number(input.imageWidth) <= 0 ||
    Number(input.imageHeight) <= 0
  ) {
    return NextResponse.json({ error: { code: "validation_failed", message: "A valid camera image and dimensions are required." } }, { status: 422 });
  }

  const claimed = await prisma.auditCaptureRequest.updateMany({
    where: { id, status: "WAITING_FOR_CAMERA", expiresAt: { gt: new Date() } },
    data: { status: "CAPTURING" },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: { code: "capture_not_pending", message: "This audit capture is no longer pending." } }, { status: 409 });
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
    const imageBuffer = Buffer.from(input.imageDataUrl.slice(input.imageDataUrl.indexOf(",") + 1), "base64");
    evidenceUrl = await uploadAuditEvidence(
      capture.binAudit.auditRunId,
      capture.binAuditId,
      capture.binAudit.bin.code,
      input.imageDataUrl,
    );
    const part = capture.binAudit.expectedPart;
    const vision = await countAuditImage(imageBuffer, {
      binCode: capture.binAudit.bin.code,
      sku: part?.sku ?? null,
      canonicalName: part?.canonicalName ?? null,
      dimensions: part
        ? { lengthMM: part.lengthMM, widthMM: part.widthMM, heightMM: part.heightMM }
        : null,
    });
    const capturedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const stored = await tx.auditCaptureRequest.updateMany({
        where: { id, status: "CAPTURING", expiresAt: { gt: capturedAt } },
        data: {
          status: "CAPTURED",
          evidenceUrl,
          visionResultJson: JSON.stringify(vision),
          imageWidth: Number(input.imageWidth),
          imageHeight: Number(input.imageHeight),
          capturedAt,
        },
      });
      if (stored.count !== 1) throw new Error("audit_capture_expired");
      await tx.binAudit.update({
        where: { id: capture.binAuditId },
        data: { evidenceUrl, capturedAt },
      });
    });
    return NextResponse.json({ ok: true, captureId: id, status: "CAPTURED" });
  } catch (error) {
    console.error(`[inventory-audit] capture failed id=${id}`, error);
    await prisma.auditCaptureRequest.update({
      where: { id },
      data: {
        status: "FAILED",
        evidenceUrl,
        errorCode: error instanceof Error && error.message === "audit_vision_invalid"
          ? "audit_vision_invalid"
          : "capture_failed",
      },
    }).catch(() => {});
    if (evidenceUrl && binAuditId) {
      await prisma.binAudit.update({
        where: { id: binAuditId },
        data: { evidenceUrl, capturedAt: new Date() },
      }).catch(() => {});
    }
    return NextResponse.json({ error: { code: "capture_failed", message: "The audit image could not be processed." } }, { status: 500 });
  }
}
