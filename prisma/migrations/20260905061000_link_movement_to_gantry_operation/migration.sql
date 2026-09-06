-- Links a warehouse Movement (intent) to the GantryOperation that executed it
-- (the machine's account). Nullable, because movements created before
-- Milestone 7 and movements rejected before the gantry ran have no operation.
-- Deliberately not a foreign key: gantry history is process-local simulator
-- state, not a database table.
-- AlterTable
ALTER TABLE "Movement" ADD COLUMN "gantryOperationId" TEXT;
