-- Authenticated Raspberry Pi heartbeat. Device connectivity is derived from
-- lastSeenAt; no browser can leave a stale ONLINE flag behind.
CREATE TABLE "public"."CameraDeviceHealth" (
    "deviceId" TEXT NOT NULL,
    "workerState" TEXT NOT NULL DEFAULT 'STARTING',
    "cameraReady" BOOLEAN NOT NULL DEFAULT false,
    "previewReady" BOOLEAN NOT NULL DEFAULT false,
    "activeJobId" TEXT,
    "cpuTemperatureC" DOUBLE PRECISION,
    "cpuLoadPercent" DOUBLE PRECISION,
    "memoryUsedPercent" DOUBLE PRECISION,
    "workerVersion" TEXT,
    "workerStartedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraDeviceHealth_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX "CameraDeviceHealth_lastSeenAt_idx"
ON "public"."CameraDeviceHealth"("lastSeenAt" ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'CameraDeviceHealth'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE "public"."CameraDeviceHealth";
  END IF;
END
$$;
