CREATE TABLE "PutawayCaptureRequest" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_CAMERA',
    "expectedQuantity" INTEGER NOT NULL,
    "observedQuantity" INTEGER,
    "countConfidence" DOUBLE PRECISION,
    "countable" BOOLEAN,
    "expectedPartPresent" BOOLEAN,
    "foreignObjectSuspected" BOOLEAN,
    "foreignObjectsJson" TEXT,
    "occlusion" TEXT,
    "notes" TEXT,
    "previousImageUrl" TEXT,
    "evidenceUrl" TEXT,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "PutawayCaptureRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PutawayCaptureRequest_movementId_key" ON "PutawayCaptureRequest"("movementId");
CREATE INDEX "PutawayCaptureRequest_status_createdAt_idx" ON "PutawayCaptureRequest"("status", "createdAt");

ALTER TABLE "PutawayCaptureRequest"
ADD CONSTRAINT "PutawayCaptureRequest_movementId_fkey"
FOREIGN KEY ("movementId") REFERENCES "Movement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
