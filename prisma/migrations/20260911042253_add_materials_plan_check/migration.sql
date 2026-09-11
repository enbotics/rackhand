-- CreateTable
CREATE TABLE "MaterialsPlanCheck" (
    "id" TEXT NOT NULL,
    "ownerSessionId" TEXT,
    "requirementsJson" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "resultJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MaterialsPlanCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialsPlanCheck_auditRunId_key" ON "MaterialsPlanCheck"("auditRunId");

-- CreateIndex
CREATE INDEX "MaterialsPlanCheck_ownerSessionId_createdAt_idx" ON "MaterialsPlanCheck"("ownerSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "MaterialsPlanCheck" ADD CONSTRAINT "MaterialsPlanCheck_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "InventoryAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
