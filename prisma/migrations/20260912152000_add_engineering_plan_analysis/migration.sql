CREATE TABLE "EngineeringPlanAnalysisRun" (
    "id" TEXT NOT NULL,
    "ownerSessionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT NOT NULL DEFAULT 'QUEUED',
    "activeKey" TEXT,
    "workDate" TEXT NOT NULL,
    "rowsFound" INTEGER NOT NULL DEFAULT 0,
    "currentBinCode" TEXT,
    "planRowsJson" TEXT NOT NULL DEFAULT '[]',
    "requirementsJson" TEXT NOT NULL DEFAULT '[]',
    "resultJson" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineeringPlanAnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EngineeringPlanAnalysisEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineeringPlanAnalysisEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngineeringPlanAnalysisRun_activeKey_key"
ON "EngineeringPlanAnalysisRun"("activeKey");

CREATE INDEX "EngineeringPlanAnalysisRun_ownerSessionId_createdAt_idx"
ON "EngineeringPlanAnalysisRun"("ownerSessionId", "createdAt");

CREATE INDEX "EngineeringPlanAnalysisRun_status_idx"
ON "EngineeringPlanAnalysisRun"("status");

CREATE UNIQUE INDEX "EngineeringPlanAnalysisEvent_runId_sequence_key"
ON "EngineeringPlanAnalysisEvent"("runId", "sequence");

CREATE INDEX "EngineeringPlanAnalysisEvent_runId_idx"
ON "EngineeringPlanAnalysisEvent"("runId");

ALTER TABLE "EngineeringPlanAnalysisEvent"
ADD CONSTRAINT "EngineeringPlanAnalysisEvent_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "EngineeringPlanAnalysisRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'EngineeringPlanAnalysisRun'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE "public"."EngineeringPlanAnalysisRun";
  END IF;
END
$$;
