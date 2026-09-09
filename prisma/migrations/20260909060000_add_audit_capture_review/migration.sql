-- AlterTable: bring AuditCaptureRequest up to the same shape as
-- PutawayCaptureRequest (individual analysis columns instead of a JSON blob,
-- plus retry/comparison support), so both flows share one decision-policy
-- and UI vocabulary.
ALTER TABLE "AuditCaptureRequest"
  ADD COLUMN "expectedQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "observedQuantity" INTEGER,
  ADD COLUMN "countConfidence" DOUBLE PRECISION,
  ADD COLUMN "countable" BOOLEAN,
  ADD COLUMN "expectedPartPresent" BOOLEAN,
  ADD COLUMN "foreignObjectSuspected" BOOLEAN,
  ADD COLUMN "foreignObjectsJson" TEXT,
  ADD COLUMN "occlusion" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "previousImageUrl" TEXT,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  DROP COLUMN "visionResultJson";
