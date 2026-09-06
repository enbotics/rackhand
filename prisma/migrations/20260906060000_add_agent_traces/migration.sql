-- CreateTable
CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "requestSummary" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "modelCalls" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "modelLatencyMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT,
    "summary" TEXT NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TraceEvent_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "AgentTrace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentTrace_status_idx" ON "AgentTrace"("status");

-- CreateIndex
CREATE INDEX "AgentTrace_startedAt_idx" ON "AgentTrace"("startedAt");

-- CreateIndex
CREATE INDEX "TraceEvent_traceId_idx" ON "TraceEvent"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_traceId_sequence_key" ON "TraceEvent"("traceId", "sequence");

