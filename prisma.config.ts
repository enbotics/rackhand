import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 moved the datasource URL and the seed command out of
 * schema.prisma and into this file, and no longer loads .env on its own.
 *
 * Same precedence fix as scripts/load-env.ts: plain `dotenv/config` only
 * reads .env, silently missing secrets in .env.local (DIRECT_URL/DATABASE_URL
 * included) — dotenv never overwrites an already-set variable, so loading
 * .env.local first is what gives it priority: shell export > .env.local
 * (secrets) > .env (committed, non-secret config).
 *
 * DIRECT_URL, not DATABASE_URL, on purpose: this config is what the CLI
 * (migrate, db push, introspect) connects with, and Supabase's connection
 * pooler runs in PgBouncer transaction mode, which doesn't support the
 * session-level features (advisory locks, prepared statements) migrations
 * need. DATABASE_URL (pooled) is what the running app actually queries
 * through — that's wired up separately in src/lib/warehouse/db.ts, entirely
 * independent of what this file points at.
 */
config({ path: ".env.local" });
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
