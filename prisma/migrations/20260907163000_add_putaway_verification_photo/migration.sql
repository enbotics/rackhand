-- AlterTable
ALTER TABLE "Movement"
ADD COLUMN "verificationImageUrl" TEXT,
ADD COLUMN "verificationCapturedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Movement_destinationBinId_verificationCapturedAt_idx"
ON "Movement"("destinationBinId", "verificationCapturedAt");
