-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "lengthMM" DOUBLE PRECISION,
    "widthMM" DOUBLE PRECISION,
    "heightMM" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bin" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "capacity" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Movement" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceBinId" TEXT,
    "destinationBinId" TEXT,
    "sourceLocation" TEXT,
    "destinationLocation" TEXT,
    "scanId" TEXT,
    "gantryOperationId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionApproval" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "interruptId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogResolution" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "originalMatchStatus" TEXT NOT NULL,
    "candidatePartIds" TEXT NOT NULL,
    "selectedPartId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CatalogResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "requestSummary" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "modelCalls" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "modelLatencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT,
    "summary" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Part_sku_key" ON "Part"("sku");

-- CreateIndex
CREATE INDEX "Part_category_idx" ON "Part"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Bin_code_key" ON "Bin"("code");

-- CreateIndex
CREATE INDEX "Bin_status_idx" ON "Bin"("status");

-- CreateIndex
CREATE INDEX "Inventory_binId_idx" ON "Inventory"("binId");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_partId_binId_key" ON "Inventory"("partId", "binId");

-- CreateIndex
CREATE UNIQUE INDEX "Movement_idempotencyKey_key" ON "Movement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Movement_status_idx" ON "Movement"("status");

-- CreateIndex
CREATE INDEX "Movement_createdAt_idx" ON "Movement"("createdAt");

-- CreateIndex
CREATE INDEX "Movement_scanId_idx" ON "Movement"("scanId");

-- CreateIndex
CREATE INDEX "ActionApproval_status_idx" ON "ActionApproval"("status");

-- CreateIndex
CREATE INDEX "ActionApproval_createdAt_idx" ON "ActionApproval"("createdAt");

-- CreateIndex
CREATE INDEX "CatalogResolution_scanId_idx" ON "CatalogResolution"("scanId");

-- CreateIndex
CREATE INDEX "CatalogResolution_status_idx" ON "CatalogResolution"("status");

-- CreateIndex
CREATE INDEX "AgentTrace_status_idx" ON "AgentTrace"("status");

-- CreateIndex
CREATE INDEX "AgentTrace_startedAt_idx" ON "AgentTrace"("startedAt");

-- CreateIndex
CREATE INDEX "TraceEvent_traceId_idx" ON "TraceEvent"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_traceId_sequence_key" ON "TraceEvent"("traceId", "sequence");

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_binId_fkey" FOREIGN KEY ("binId") REFERENCES "Bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_sourceBinId_fkey" FOREIGN KEY ("sourceBinId") REFERENCES "Bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_destinationBinId_fkey" FOREIGN KEY ("destinationBinId") REFERENCES "Bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogResolution" ADD CONSTRAINT "CatalogResolution_selectedPartId_fkey" FOREIGN KEY ("selectedPartId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "AgentTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
