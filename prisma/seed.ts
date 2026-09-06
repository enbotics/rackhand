/**
 * Seeds the six MVP warehouse bins and a small demo catalog.
 *
 * Idempotent by construction: every row is upserted with an empty `update`,
 * so re-running never duplicates anything and never resets a bin that has
 * since become OCCUPIED/RESERVED/DISABLED or a catalog part someone has
 * edited. Seeding is explicit (`npm run db:seed`) rather than something a
 * request triggers.
 *
 * The demo parts exist so catalog matching has something realistic to match
 * against. They are ordinary catalog rows — delete them freely; set
 * SEED_DEMO_CATALOG=0 to skip creating them.
 *
 * Uses a relative import for the generated client because this runs under
 * tsx via the Prisma CLI, outside Next.js's module resolution.
 */
import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import { SEED_BIN_CODES } from "../src/lib/warehouse/types";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

/**
 * A small demo catalog for exercising the matcher, chosen so all three match
 * states are reachable:
 *  - BRG-6204 / BRG-6205 are named alike but differ in size, so dimensions
 *    settle it and a 6204 scan comes back MATCHED with 6205 as an alternative.
 *  - BOLT-M8-50 / BOLT-M8-50-FLG differ by 1mm across the head, so a scan of
 *    "M8 bolt" is genuinely AMBIGUOUS and must not be guessed at.
 *  - Anything unrelated (a jaw coupling, say) reaches NO_MATCH.
 * Dimensions are realistic (bearing OD x OD x width, bolt length x head A/F).
 */
const DEMO_PARTS = [
  {
    sku: "BRG-6204",
    canonicalName: "6204 Deep Groove Ball Bearing",
    category: "bearing",
    description: "Single-row deep groove ball bearing, 20mm bore",
    lengthMM: 47,
    widthMM: 47,
    heightMM: 14,
  },
  {
    sku: "BRG-6205",
    canonicalName: "6205 Deep Groove Ball Bearing",
    category: "bearing",
    description: "Single-row deep groove ball bearing, 25mm bore",
    lengthMM: 52,
    widthMM: 52,
    heightMM: 15,
  },
  {
    sku: "BOLT-M8-50",
    canonicalName: "M8 x 50 Hex Bolt",
    category: "fastener",
    description: "Zinc-plated steel hex head bolt",
    lengthMM: 50,
    widthMM: 13,
    heightMM: 5.3,
  },
  {
    sku: "BOLT-M8-50-FLG",
    canonicalName: "M8 x 50 Flange Bolt",
    category: "fastener",
    description: "Zinc-plated steel flange head bolt",
    lengthMM: 50,
    widthMM: 14,
    heightMM: 5.3,
  },
  {
    sku: "BOLT-M10-60",
    canonicalName: "M10 x 60 Hex Bolt",
    category: "fastener",
    description: "Zinc-plated steel hex head bolt",
    lengthMM: 60,
    widthMM: 17,
    heightMM: 6.4,
  },
];

async function main() {
  for (const code of SEED_BIN_CODES) {
    await prisma.bin.upsert({
      where: { code },
      update: {},
      create: { code, status: "AVAILABLE", capacity: 100 },
    });
  }

  const bins = await prisma.bin.findMany({ orderBy: { code: "asc" } });
  console.log(`Seeded ${SEED_BIN_CODES.length} bins; database now holds ${bins.length}:`);
  for (const bin of bins) {
    console.log(`  ${bin.code}  ${bin.status}  capacity ${bin.capacity}`);
  }

  if (process.env.SEED_DEMO_CATALOG === "0") {
    console.log("\nSkipping demo catalog (SEED_DEMO_CATALOG=0).");
    return;
  }

  for (const part of DEMO_PARTS) {
    // Empty `update` — an existing SKU is left exactly as the user has it.
    await prisma.part.upsert({ where: { sku: part.sku }, update: {}, create: part });
  }

  const parts = await prisma.part.findMany({ orderBy: { sku: "asc" } });
  console.log(`\nSeeded ${DEMO_PARTS.length} demo catalog parts; catalog now holds ${parts.length}:`);
  for (const part of parts) {
    const dims = [part.lengthMM, part.widthMM, part.heightMM]
      .map((d) => (d === null ? "?" : String(d)))
      .join(" x ");
    console.log(`  ${part.sku.padEnd(12)} ${part.canonicalName}  (${dims} mm)`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
