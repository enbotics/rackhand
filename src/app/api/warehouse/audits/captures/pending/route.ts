import { NextResponse } from "next/server";
import { prisma } from "@/lib/warehouse/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only poll used by the already-open Warehouse Command Center camera. */
export async function GET() {
  const capture = await prisma.auditCaptureRequest.findFirst({
    where: { status: "WAITING_FOR_CAMERA", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    include: { binAudit: { include: { bin: true } } },
  });
  return NextResponse.json(
    capture
      ? {
          captureId: capture.id,
          auditRunId: capture.binAudit.auditRunId,
          binAuditId: capture.binAuditId,
          binCode: capture.binAudit.bin.code,
          status: capture.status,
          expiresAt: capture.expiresAt.toISOString(),
        }
      : { captureId: null },
  );
}
