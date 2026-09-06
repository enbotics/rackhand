/**
 * The single PrismaClient for the authoritative warehouse database.
 *
 * Prisma 7 has no query engine binary — SQLite access goes through the
 * better-sqlite3 driver adapter, and the connection URL comes from
 * DATABASE_URL (Next.js loads .env itself; the Prisma CLI loads it via
 * dotenv in prisma.config.ts).
 *
 * Cached on globalThis in development so Next.js hot reloads reuse one
 * client instead of opening a new SQLite handle on every module reload.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

/** Matches .env — kept as a fallback so tooling without env loading still works. */
const DEFAULT_DATABASE_URL = "file:./prisma/dev.db";

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { warehousePrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.warehousePrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.warehousePrisma = prisma;
}
