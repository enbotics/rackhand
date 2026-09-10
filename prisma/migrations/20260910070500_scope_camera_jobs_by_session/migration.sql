ALTER TABLE "PutawayCaptureRequest"
ADD COLUMN "ownerSessionId" TEXT;

ALTER TABLE "RetrievalCaptureRequest"
ADD COLUMN "ownerSessionId" TEXT;

ALTER TABLE "AuditCaptureRequest"
ADD COLUMN "ownerSessionId" TEXT;

ALTER TABLE "CameraCaptureJob"
ADD COLUMN "ownerSessionId" TEXT;

CREATE INDEX "PutawayCaptureRequest_ownerSessionId_status_createdAt_idx"
ON "PutawayCaptureRequest"("ownerSessionId", "status", "createdAt");

CREATE INDEX "RetrievalCaptureRequest_ownerSessionId_status_createdAt_idx"
ON "RetrievalCaptureRequest"("ownerSessionId", "status", "createdAt");

CREATE INDEX "AuditCaptureRequest_ownerSessionId_status_createdAt_idx"
ON "AuditCaptureRequest"("ownerSessionId", "status", "createdAt");

CREATE INDEX "CameraCaptureJob_ownerSessionId_status_requestedAt_idx"
ON "CameraCaptureJob"("ownerSessionId", "status", "requestedAt");
