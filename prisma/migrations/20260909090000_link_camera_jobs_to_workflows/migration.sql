-- Link Raspberry Pi captures to the durable putaway/audit capture handshake
-- they satisfy. The relation is intentionally polymorphic: purpose determines
-- whether the id names PutawayCaptureRequest or AuditCaptureRequest.
ALTER TABLE "public"."CameraCaptureJob"
ADD COLUMN "workflowCaptureId" TEXT;

CREATE INDEX "CameraCaptureJob_workflowCaptureId_status_idx"
ON "public"."CameraCaptureJob"("workflowCaptureId" ASC, "status" ASC);
