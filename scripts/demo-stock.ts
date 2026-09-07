/**
 * Deterministic sample stock for demos — `npm run demo:stock`.
 *
 * DEVELOPMENT / DEMO ONLY, like demo-reset.ts. It places stock through the
 * warehouse inventory SERVICE, not with raw inserts, so every sample row obeys
 * the same rules a real putaway does: one SKU per bin, bin capacity, no
 * storing into a DISABLED bin, and the bin becoming OCCUPIED as a consequence
 * rather than being set by hand. Sample data that broke those rules would put
 * the dashboard into a state the application itself can never produce.
 *
 * NO GANTRY RUNS AND NO MOVEMENTS ARE CREATED. This is a starting position,
 * not a history — it deliberately does not pretend that a machine moved these
 * parts. Movement history comes from actually doing a putaway or retrieval.
 *
 * THE LAYOUT IS CHOSEN SO EVERY DEMO PATH IS REACHABLE:
 *
 *   B1-01  BRG-6204     x2   retrieval leaves the bin OCCUPIED (2 -> 1)
 *   B1-02  BOLT-M8-50   x1   retrieval empties it, so the bin frees itself
 *   B2-03  BRG-6204     x1   same SKU on a DIFFERENT BED, so Inventory shows
 *                            the aggregate "B1-01 (2), B2-03 (1)" that the bin
 *                            map cannot, and the gantry has to change height
 *   B3-05  BOLT-M10-60  x4   a larger holding, far corner of the shelf
 *
 * The other twenty-six slots stay AVAILABLE, so a putaway always has somewhere
 * to go and the deterministic "lowest available bin" policy has a visible
 * order to follow: it fills bed 1 left to right before climbing to bed 2.
 *
 * BRG-6205 and BOLT-M8-50-FLG are left in the catalog with NO stock on
 * purpose: that is what makes `out_of_stock` demonstrable, and distinguishable
 * from `part_not_found` for a SKU like BRG-9999 that does not exist at all.
 */
import "./load-env";
import { prisma } from "../src/lib/warehouse/db";
import { addInventory } from "../src/lib/warehouse/inventory-service";

export interface StockRow {
  sku: string;
  binCode: string;
  quantity: number;
  /** Why this row exists, printed so a demo operator knows what it is for. */
  purpose: string;
}

export const DEMO_STOCK: StockRow[] = [
  { sku: "BRG-6204", binCode: "B1-01", quantity: 2, purpose: "retrieval leaves the bin OCCUPIED" },
  { sku: "BOLT-M8-50", binCode: "B1-02", quantity: 1, purpose: "retrieval frees the bin" },
  { sku: "BRG-6204", binCode: "B2-03", quantity: 1, purpose: "same part, a different bed" },
  { sku: "BOLT-M10-60", binCode: "B3-05", quantity: 4, purpose: "a larger holding, far corner" },
];

/** True when the catalog has every SKU the sample layout needs. */
async function missingParts(): Promise<string[]> {
  const skus = [...new Set(DEMO_STOCK.map((row) => row.sku))];
  const found = await prisma.part.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
  return skus.filter((sku) => !found.some((part) => part.sku === sku));
}

/**
 * Places the sample layout. Idempotent in the sense that matters for a demo:
 * it refuses rather than doubling stock that is already there, because
 * `addInventory` ACCUMULATES and running this twice would silently give you
 * four bearings in B1-01.
 */
export async function seedDemoStock(): Promise<{ placed: number; skipped: string[] }> {
  const missing = await missingParts();
  if (missing.length > 0) {
    throw new Error(
      `Catalog is missing ${missing.join(", ")}. Run \`npm run db:seed\` first (it is idempotent).`,
    );
  }

  const skipped: string[] = [];
  let placed = 0;

  for (const row of DEMO_STOCK) {
    const bin = await prisma.bin.findUnique({ where: { code: row.binCode } });
    if (!bin) {
      skipped.push(`${row.binCode} — no such bin`);
      continue;
    }
    const occupied = await prisma.inventory.count({
      where: { binId: bin.id, quantity: { gt: 0 } },
    });
    if (occupied > 0) {
      // Adding here would either break one-SKU-per-bin or quietly double an
      // existing holding. Neither is a state to hand to a demo.
      skipped.push(`${row.binCode} — already holds stock`);
      continue;
    }

    await addInventory({ sku: row.sku, binCode: row.binCode, quantity: row.quantity });
    placed += 1;
    console.log(
      `  ${row.binCode}  ${row.sku.padEnd(12)} x${row.quantity}   ${row.purpose}`,
    );
  }

  return { placed, skipped };
}

/** Prints the resulting warehouse the way the dashboard shows it. */
export async function printWarehouse(): Promise<void> {
  const bins = await prisma.bin.findMany({
    orderBy: { code: "asc" },
    include: { inventory: { include: { part: true } } },
  });

  console.log("\nDigital warehouse (bin-first — every bin, including empty ones):");
  for (const bin of bins) {
    const held = bin.inventory.filter((row) => row.quantity > 0);
    const contents = held.map((row) => `${row.part.sku} x${row.quantity}`).join(", ") || "empty";
    console.log(`  ${bin.code}  ${bin.status.padEnd(10)} ${contents}`);
  }

  const parts = await prisma.part.findMany({
    orderBy: { sku: "asc" },
    include: { inventory: { include: { bin: true } } },
  });

  console.log("\nInventory (part-first — only what is in stock, summed across bins):");
  let units = 0;
  let stocked = 0;
  for (const part of parts) {
    const held = part.inventory.filter((row) => row.quantity > 0);
    if (held.length === 0) continue;
    stocked += 1;
    const total = held.reduce((sum, row) => sum + row.quantity, 0);
    units += total;
    const where = held
      .sort((a, b) => a.bin.code.localeCompare(b.bin.code))
      .map((row) => `${row.bin.code} (${row.quantity})`)
      .join(", ");
    console.log(`  ${part.sku.padEnd(14)} Qty ${String(total).padStart(2)}   ${where}`);
  }
  console.log(`\n  ${stocked} parts in stock, ${units} units total.`);

  const empty = parts.filter((part) => part.inventory.every((row) => row.quantity === 0));
  if (empty.length > 0) {
    console.log(
      `  In the catalog with no stock (so retrieval returns out_of_stock): ` +
        empty.map((part) => part.sku).join(", "),
    );
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("demo:stock refuses to run with NODE_ENV=production.");
  }
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  if (!url.startsWith("file:")) {
    throw new Error(`demo:stock refuses to run against DATABASE_URL="${url}".`);
  }

  console.log(`demo:stock — target ${url}\n`);
  const { placed, skipped } = await seedDemoStock();
  if (placed === 0) console.log("  (nothing placed)");
  for (const note of skipped) console.log(`  skipped ${note}`);

  await printWarehouse();
  console.log("\ndemo:stock complete.");
}

// Only when run directly, so demo-reset.ts can import seedDemoStock.
if (process.argv[1]?.includes("demo-stock")) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
