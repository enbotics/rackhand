ALTER TABLE "EngineeringPlanAnalysisRun"
  ADD COLUMN "sourceFingerprint" TEXT,
  ADD COLUMN "sourceContextJson" TEXT,
  ADD COLUMN "checkpointJson" TEXT;

CREATE TABLE "EngineeringPlanInbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "signalAt" TIMESTAMP(3) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "pending" BOOLEAN NOT NULL DEFAULT true,
  "lastFingerprint" TEXT,
  "lastWorkDate" TEXT,
  "lastError" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "WarehouseHardwareLease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "WarehouseClientActivity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "WarehouseClientActivity_expiresAt_idx" ON "WarehouseClientActivity"("expiresAt");
