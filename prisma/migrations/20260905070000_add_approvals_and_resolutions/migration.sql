-- Milestone 9: human-in-the-loop audit tables.
-- ActionApproval records approve/deny decisions for state-changing agent
-- actions. CatalogResolution records which catalog Part a person chose for
-- an AMBIGUOUS scan. Neither ever stores model reasoning, prompts,
-- credentials or images. Strands interrupt state is NOT stored here: it is
-- runtime execution state held in a bounded in-process store, not warehouse
-- truth, and must not be resumable across a restart.
-- CreateTable
CREATE TABLE "ActionApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "interruptId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CatalogResolution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "originalMatchStatus" TEXT NOT NULL,
    "candidatePartIds" TEXT NOT NULL,
    "selectedPartId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    CONSTRAINT "CatalogResolution_selectedPartId_fkey" FOREIGN KEY ("selectedPartId") REFERENCES "Part" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ActionApproval_status_idx" ON "ActionApproval"("status");

-- CreateIndex
CREATE INDEX "ActionApproval_createdAt_idx" ON "ActionApproval"("createdAt");

-- CreateIndex
CREATE INDEX "CatalogResolution_scanId_idx" ON "CatalogResolution"("scanId");

-- CreateIndex
CREATE INDEX "CatalogResolution_status_idx" ON "CatalogResolution"("status");

