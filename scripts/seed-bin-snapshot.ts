/**
 * Resets a bin's simulation baseline: a starting stock quantity AND a
 * "current snapshot" evidence photo, so AUDIT_CAPTURE_MODE=simulation has
 * something real to show as this bin's latest accepted state before the
 * next simulated capture runs. The photo is the bin's own curated demo
 * image (public/audit-simulation/<BIN>/snapshot.jpg) — same free, no-
 * Supabase storage the simulated capture pool itself uses.
 *
 * SAFE TO RE-RUN. Unlike a one-shot seed, this is meant to be run again and
 * again between test passes — it resets whatever quantity is currently
 * there (including one a prior simulated audit/putaway left behind) back to
 * the given baseline, and records a fresh VERIFIED "accepted snapshot" so
 * the next simulated capture's comparison dialog shows a clean known
 * starting point rather than whatever the last test happened to leave.
 *
 * DEVELOPMENT / DEMO ONLY, like scripts/demo-stock.ts. Run with:
 *   npx tsx scripts/seed-bin-snapshot.ts <BIN_CODE> <SKU> <QUANTITY>
 */
import "./load-env";
import { prisma } from "../src/lib/warehouse/db";
import { addInventory, setInventoryQuantity } from "../src/lib/warehouse/inventory-service";

async function main(): Promise<void> {
  const [binCode, sku, quantityRaw] = process.argv.slice(2);
  const quantity = Number(quantityRaw);
  if (!binCode || !sku || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Usage: tsx scripts/seed-bin-snapshot.ts <BIN_CODE> <SKU> <QUANTITY>");
  }

  const bin = await prisma.bin.findUnique({ where: { code: binCode } });
  if (!bin) throw new Error(`No such bin: ${binCode}`);
  const part = await prisma.part.findUnique({ where: { sku } });
  if (!part) throw new Error(`No such part: ${sku}`);

  const existing = await prisma.inventory.findUnique({
    where: { partId_binId: { partId: part.id, binId: bin.id } },
  });
  if (!existing) {
    await addInventory({ sku, binCode, quantity });
    console.log(`Placed ${quantity} x ${sku} in ${binCode}.`);
  } else if (existing.quantity !== quantity) {
    await setInventoryQuantity({ sku, binCode, quantity });
    console.log(`Reset ${binCode} from ${existing.quantity} to ${quantity} x ${sku}.`);
  } else {
    console.log(`${binCode} already holds ${quantity} x ${sku} — quantity unchanged.`);
  }

  const evidenceUrl = `/audit-simulation/${binCode}/snapshot.jpg`;
  const now = new Date();
  const run = await prisma.inventoryAuditRun.create({
    data: {
      trigger: "TRUSTED_INTERNAL",
      status: "COMPLETED",
      requestedBinCode: binCode,
      binsPlanned: 1,
      binsCompleted: 1,
      verifiedBins: 1,
      startedAt: now,
      completedAt: now,
    },
  });
  await prisma.binAudit.create({
    data: {
      auditRunId: run.id,
      binId: bin.id,
      expectedPartId: part.id,
      expectedQuantity: quantity,
      observedQuantity: quantity,
      countConfidence: 1,
      countable: true,
      expectedPartPresent: true,
      foreignObjectSuspected: false,
      occlusion: "NONE",
      status: "VERIFIED",
      evidenceUrl,
      inventoryUpdated: false,
      previousQuantity: quantity,
      newQuantity: quantity,
      startedAt: now,
      capturedAt: now,
      completedAt: now,
    },
  });
  console.log(`Recorded ${binCode}'s current accepted snapshot: ${evidenceUrl}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
