-- Inventory Auditor Agent persistence and browser-camera handshake.
CREATE TABLE "InventoryAuditRun" (
  "id" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestedBinCode" TEXT,
  "activeKey" TEXT,
  "binsPlanned" INTEGER NOT NULL DEFAULT 0,
  "binsCompleted" INTEGER NOT NULL DEFAULT 0,
  "verifiedBins" INTEGER NOT NULL DEFAULT 0,
  "reconciledBins" INTEGER NOT NULL DEFAULT 0,
  "reviewRequiredBins" INTEGER NOT NULL DEFAULT 0,
  "failedBins" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryAuditRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BinAudit" (
  "id" TEXT NOT NULL,
  "auditRunId" TEXT NOT NULL,
  "binId" TEXT NOT NULL,
  "expectedPartId" TEXT,
  "expectedQuantity" INTEGER NOT NULL,
  "observedQuantity" INTEGER,
  "countConfidence" DOUBLE PRECISION,
  "countable" BOOLEAN,
  "expectedPartPresent" BOOLEAN,
  "foreignObjectSuspected" BOOLEAN,
  "occlusion" TEXT,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "evidenceUrl" TEXT,
  "inventoryUpdated" BOOLEAN NOT NULL DEFAULT false,
  "previousQuantity" INTEGER,
  "newQuantity" INTEGER,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BinAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditCaptureRequest" (
  "id" TEXT NOT NULL,
  "binAuditId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_CAMERA',
  "evidenceUrl" TEXT,
  "visionResultJson" TEXT,
  "imageWidth" INTEGER,
  "imageHeight" INTEGER,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "capturedAt" TIMESTAMP(3),
  CONSTRAINT "AuditCaptureRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryAuditRun_activeKey_key" ON "InventoryAuditRun"("activeKey");
CREATE INDEX "InventoryAuditRun_status_idx" ON "InventoryAuditRun"("status");
CREATE INDEX "InventoryAuditRun_createdAt_idx" ON "InventoryAuditRun"("createdAt");
CREATE UNIQUE INDEX "BinAudit_auditRunId_binId_key" ON "BinAudit"("auditRunId", "binId");
CREATE INDEX "BinAudit_binId_createdAt_idx" ON "BinAudit"("binId", "createdAt");
CREATE INDEX "BinAudit_status_idx" ON "BinAudit"("status");
CREATE UNIQUE INDEX "AuditCaptureRequest_binAuditId_key" ON "AuditCaptureRequest"("binAuditId");
CREATE INDEX "AuditCaptureRequest_status_createdAt_idx" ON "AuditCaptureRequest"("status", "createdAt");

ALTER TABLE "BinAudit" ADD CONSTRAINT "BinAudit_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "InventoryAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BinAudit" ADD CONSTRAINT "BinAudit_binId_fkey" FOREIGN KEY ("binId") REFERENCES "Bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BinAudit" ADD CONSTRAINT "BinAudit_expectedPartId_fkey" FOREIGN KEY ("expectedPartId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditCaptureRequest" ADD CONSTRAINT "AuditCaptureRequest_binAuditId_fkey" FOREIGN KEY ("binAuditId") REFERENCES "BinAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
