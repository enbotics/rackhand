/**
 * Deterministic putaway demo — `npx tsx scripts/putaway-demo.ts`.
 *
 * Drives PutawayService directly against the development database with no LLM
 * involved, so the warehouse workflow can be demonstrated and debugged
 * independently of Bedrock.
 */
import "./load-env";
import { executePutaway } from "../src/lib/warehouse/putaway-service";
import { listBins, listRecentMovements } from "../src/lib/warehouse/repository";
import { listInventory } from "../src/lib/warehouse/inventory-service";
import { getGantryController } from "../src/lib/gantry/factory";
import type { ScanResult } from "../src/lib/warehouse/scan-types";

const scanResult: ScanResult = {
  scanId: process.argv[3] ?? `scan_${Date.now()}_demo`,
  capturedAt: Date.now(),
  object: {
    detectedName: "6204 bearing",
    description: "Metal circular bearing with visible inner and outer races.",
  },
  dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
  quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
  orientation: { angleDegrees: 12.4 },
};

async function show(label: string) {
  const [bins, inventory, movements, ops] = await Promise.all([
    listBins(),
    listInventory(),
    listRecentMovements(5),
    getGantryController().getRecentOperations(5),
  ]);
  console.log(`\n--- ${label} ---`);
  console.log("bins:      " + bins.map((b) => `${b.code}=${b.status}`).join(", "));
  console.log(
    "inventory: " +
      (inventory.map((r) => `${r.sku}@${r.binCode}x${r.quantity}`).join(", ") || "(empty)"),
  );
  console.log(
    "movements: " +
      (movements.map((m) => `${m.type}:${m.status}${m.scanId ? `(${m.scanId})` : ""}`).join(", ") ||
        "(none)"),
  );
  console.log(
    "gantry:    " + (ops.map((o) => `${o.type}:${o.status}->${o.destination}`).join(", ") || "(none)"),
  );
}

async function main() {
  await show("BEFORE");
  const result = await executePutaway({
    scanResult,
    ...(process.argv[2] && process.argv[2] !== "auto" ? { destinationBinCode: process.argv[2] } : {}),
  });
  console.log("\nresult: " + JSON.stringify(result, null, 2));
  await show("AFTER");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
