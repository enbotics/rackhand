-- DropForeignKey
ALTER TABLE "RetrievalCaptureRequest" DROP CONSTRAINT "RetrievalCaptureRequest_movementId_fkey";

-- AlterTable
ALTER TABLE "AuditCaptureRequest" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- DropTable
DROP TABLE "RetrievalCaptureRequest";
