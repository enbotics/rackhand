ALTER TABLE "Movement"
ADD COLUMN "weightSource" TEXT;

ALTER TABLE "PutawayCaptureRequest"
ADD COLUMN "weightSource" TEXT;

ALTER TABLE "CameraCaptureJob"
ADD COLUMN "weightSource" TEXT;
