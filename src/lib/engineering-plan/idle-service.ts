import { prisma } from "@/lib/warehouse/db";
import { getGantryController } from "@/lib/gantry/factory";
import { getCameraDeviceHealth } from "@/lib/camera/device-health-service";
import { getAuditCaptureMode } from "@/lib/warehouse/audit-capture-mode";

/** Database facts authorize unattended work, not LLM text or a browser timer. */
export async function warehouseIdleReason(requireCamera = false): Promise<string | null> {
  const now = new Date();
  const [client, approval, bin, movement, audit, cameraJob] = await Promise.all([
    prisma.warehouseClientActivity.findFirst({ where: { expiresAt: { gt: now } } }),
    prisma.actionApproval.findFirst({ where: { status: "PENDING", expiresAt: { gt: now } } }),
    prisma.bin.findFirst({ where: { status: { notIn: ["AVAILABLE", "OCCUPIED"] } } }),
    prisma.movement.findFirst({ where: { status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } } }),
    prisma.inventoryAuditRun.findFirst({ where: { activeKey: "ACTIVE" } }),
    prisma.cameraCaptureJob.findFirst({ where: { status: { in: ["PENDING", "CLAIMED", "UPLOADED", "PROCESSING"] } } }),
  ]);
  if (client) return "A client request has priority. I’ll continue when it is settled.";
  if (approval) return "Waiting for the current human decision.";
  if (bin) return `Waiting for ${bin.code} to be safely returned and available on the shelf.`;
  if (movement || audit) return "Waiting for the current warehouse operation to finish.";
  if (cameraJob) return "Waiting for the shared Pi camera to finish its current capture.";
  const gantry = await getGantryController().getStatus();
  if (gantry.state !== "IDLE" || gantry.activeOperationId || gantry.carrying || gantry.lastError)
    return "Waiting for the gantry to be safely ready.";
  if (gantry.currentLocation !== null) return "Waiting for the gantry to return home.";
  if (requireCamera && getAuditCaptureMode() === "PROD") {
    const camera = await getCameraDeviceHealth();
    if (camera.connection !== "ONLINE" || !camera.cameraReady || camera.activeJobId)
      return "The Pi camera is not ready. I’ll keep this stock check queued until it is healthy and free.";
  }
  // A fresh simulator at null is safely parked even before its first home.
  return null;
}
