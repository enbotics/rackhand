-- One nullable constant acts as a cross-process mutex for the single physical
-- putaway workflow. PostgreSQL permits multiple NULLs in a unique index, so
-- every terminal/history row remains unconstrained.
ALTER TABLE "Movement" ADD COLUMN "putawayActiveKey" TEXT;

CREATE UNIQUE INDEX "Movement_putawayActiveKey_key"
ON "Movement"("putawayActiveKey");
