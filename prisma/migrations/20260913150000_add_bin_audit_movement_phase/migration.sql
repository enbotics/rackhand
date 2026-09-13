-- Persist the audit bin's physical simulation phase so every browser/server
-- process can render the same shelf -> checkout -> shelf trip.
ALTER TABLE "BinAudit"
ADD COLUMN "movementPhase" TEXT,
ADD COLUMN "movementPhaseStartedAt" TIMESTAMP(3);
