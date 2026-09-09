-- Human-operated camera workflows must not expire while the operator is
-- deciding when to capture or reviewing the result. `expiresAt` is now only
-- an active device/server processing lease and is therefore nullable.
ALTER TABLE "PutawayCaptureRequest"
  ALTER COLUMN "expiresAt" DROP NOT NULL;

ALTER TABLE "AuditCaptureRequest"
  ALTER COLUMN "expiresAt" DROP NOT NULL;

ALTER TABLE "CameraCaptureJob"
  ALTER COLUMN "expiresAt" DROP NOT NULL,
  ADD COLUMN "workflowAttempt" INTEGER;
