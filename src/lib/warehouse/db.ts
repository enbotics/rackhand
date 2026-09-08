/**
 * The single PrismaClient for the authoritative warehouse database.
 *
 * Prisma 7 has no query engine binary — Postgres access goes through the
 * `pg` driver adapter. The connection URL is DATABASE_URL, the POOLED
 * (PgBouncer, transaction mode, port 6543) Supabase connection string — this
 * is the one the running app actually queries through. It is deliberately
 * NOT the same URL prisma.config.ts uses for the CLI (DIRECT_URL, port 5432):
 * the app makes many short-lived connections per request, which is exactly
 * what a transaction-mode pooler is for, while `prisma migrate` needs a
 * direct session the pooler can't give it. Next.js loads .env.local/.env
 * itself; standalone scripts load them via scripts/load-env.ts.
 *
 * Cached on globalThis in development so Next.js hot reloads reuse one
 * client (and one connection pool) instead of opening a new one on every
 * module reload.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — see .env.local (Supabase pooled connection string).",
    );
  }
  const adapter = new PrismaPg(url);
  return new PrismaClient({
    adapter,
    // Prisma's defaults (maxWait 2s, timeout 5s) assume a fast local
    // database. Against Supabase's pooled connection, a `$transaction` call
    // competing with the app's own read-polling (overview/gantry/trace hooks,
    // each on their own interval) can easily fail to acquire a connection
    // within 2s under normal load — surfacing as P2028 "Unable to start a
    // transaction in the given time" on an otherwise-correct request, not a
    // logic error. Widening both gives real contention room to clear instead
    // of hard-failing a legitimate write.
    transactionOptions: { maxWait: 10_000, timeout: 20_000 },
  });
}

const globalForPrisma = globalThis as unknown as { warehousePrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.warehousePrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.warehousePrisma = prisma;
}
