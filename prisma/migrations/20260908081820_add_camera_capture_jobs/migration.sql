-- CreateTable
CREATE TABLE "public"."CameraCaptureJob" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "binAuditId" TEXT,
    "evidenceUrl" TEXT,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "resultJson" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraCaptureJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CameraCaptureJob_binAuditId_idx" ON "public"."CameraCaptureJob"("binAuditId" ASC);

-- CreateIndex
CREATE INDEX "CameraCaptureJob_deviceId_status_requestedAt_idx" ON "public"."CameraCaptureJob"("deviceId" ASC, "status" ASC, "requestedAt" ASC);

-- CreateIndex
CREATE INDEX "CameraCaptureJob_status_idx" ON "public"."CameraCaptureJob"("status" ASC);
