-- AlterTable: BinAudit gains a durable "before" photo, computed once at
-- finalize time, so the audit history panel can show a real comparison
-- (previous accepted snapshot vs. this capture) instead of one bare image.
ALTER TABLE "BinAudit" ADD COLUMN "priorEvidenceUrl" TEXT;
