-- Milestone 7 putaway idempotency.
--
-- scanId is durable provenance: which physical scan a movement came from.
-- It is never cleared, so failed attempts stay traceable, and it is indexed
-- rather than unique because one scan may legitimately produce several
-- movement records over successive retries.
--
-- idempotencyKey is the active claim on a scan. It holds the scanId while a
-- putaway is PENDING/VALIDATED/RUNNING/COMPLETED and is set to NULL when the
-- movement reaches FAILED or CANCELLED, freeing the operator to retry the same
-- physical item. It is UNIQUE so two concurrent submissions of one scan cannot
-- both claim it — the database rejects the second rather than a read-then-write
-- check that could go stale. SQLite permits many NULLs in a unique index, which
-- is exactly what lets pre-Milestone-7 movements and released claims coexist.
-- AlterTable
ALTER TABLE "Movement" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Movement" ADD COLUMN "scanId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Movement_idempotencyKey_key" ON "Movement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Movement_scanId_idx" ON "Movement"("scanId");
