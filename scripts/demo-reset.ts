/**
 * DEVELOPMENT / DEMO ONLY — `npm run demo:reset`.
 *
 * Returns the local warehouse to one deterministic state so a demonstration
 * starts the same way every time. It is a command, never an HTTP endpoint and
 * never a button: nothing a browser can reach may empty the warehouse, which
 * is why Milestone 10 has no RESET control and this file exists instead.
 *
 * Two guards stand in front of the destructive part:
 *   - NODE_ENV must not be "production";
 *   - DATABASE_URL must be a local SQLite file.
 * Either one failing aborts before a single row is deleted.
 *
 * WHAT IT CLEARS (all of it local, none of it audit history worth keeping
 * beyond a demo): inventory, movements, approvals, catalog resolutions and
 * observability traces. Bins are returned to AVAILABLE and the demo catalog is
 * re-seeded. The gantry simulator is process-local, so its operation history
 * and IDLE state come back on their own when the dev server restarts — this
 * script says so rather than pretending to reach into another process.
 */
import "./load-env";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import { SEED_BIN_CODES } from "../src/lib/warehouse/types";

/** The demo catalog. Matches prisma/seed.ts, which stays the single seed source. */
const DEMO_SKUS = ["BRG-6204", "BRG-6205", "BOLT-M8-50", "BOLT-M8-50-FLG", "BOLT-M10-60"];

function assertSafeTarget(url: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("demo:reset refuses to run with NODE_ENV=production.");
  }
  if (!url.startsWith("file:")) {
    throw new Error(
      `demo:reset refuses to run against DATABASE_URL="${url}" — it must be a local SQLite file.`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  assertSafeTarget(url);

  console.log(`demo:reset — target ${url}\n`);

  const adapter = new PrismaBetterSqlite3({ url });
  const prisma = new PrismaClient({ adapter });

  try {
    // Deletion order respects the onDelete: Restrict relations — resolutions
    // point at Parts, inventory and movements point at Parts and Bins.
    const cleared = {
      traceEvents: (await prisma.traceEvent.deleteMany()).count,
      traces: (await prisma.agentTrace.deleteMany()).count,
      approvals: (await prisma.actionApproval.deleteMany()).count,
      resolutions: (await prisma.catalogResolution.deleteMany()).count,
      movements: (await prisma.movement.deleteMany()).count,
      inventory: (await prisma.inventory.deleteMany()).count,
    };

    for (const [what, count] of Object.entries(cleared)) {
      console.log(`  cleared ${String(count).padStart(4)} ${what}`);
    }

    // Bins are reset rather than deleted, so their ids stay stable across a
    // demo and nothing that references one is orphaned.
    for (const code of SEED_BIN_CODES) {
      await prisma.bin.upsert({
        where: { code },
        update: { status: "AVAILABLE" },
        create: { code, status: "AVAILABLE", capacity: 100 },
      });
    }

    const parts = await prisma.part.findMany({
      where: { sku: { in: DEMO_SKUS } },
      select: { sku: true },
    });
    const missing = DEMO_SKUS.filter((sku) => !parts.some((part) => part.sku === sku));

    console.log("\nBins:");
    for (const bin of await prisma.bin.findMany({ orderBy: { code: "asc" } })) {
      console.log(`  ${bin.code}  ${bin.status}`);
    }

    console.log("\nCatalog:");
    for (const part of await prisma.part.findMany({ orderBy: { sku: "asc" } })) {
      console.log(`  ${part.sku}`);
    }
    if (missing.length > 0) {
      console.log(`\n  Missing demo parts: ${missing.join(", ")}`);
      console.log("  Run `npm run db:seed` to create them (it is idempotent).");
    }

    console.log("\nInventory: empty");
    console.log("Approvals: none pending");
    console.log("Resolutions: none pending");
    console.log("Traces: none");
    console.log(
      "\nGantry: SIMULATION. Its operation history and any parked approval are\n" +
        "process-local — restart `npm run dev` to return the machine to IDLE with\n" +
        "an empty history.",
    );
    console.log("\ndemo:reset complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
