import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BinInspectionEvidence } from "./bin-inspection-service";

const ROOT = path.join(process.cwd(), "public", "audit-simulation");

const globalForSimulationEvidence = globalThis as unknown as {
  simulationEvidenceCursor?: Map<string, number>;
  simulatedWorkflowCaptures?: Set<string>;
};

const cursors = globalForSimulationEvidence.simulationEvidenceCursor ??= new Map<string, number>();
const simulatedCaptures = globalForSimulationEvidence.simulatedWorkflowCaptures ??= new Set<string>();

export class SimulationEvidenceError extends Error {
  constructor(readonly binCode: string) {
    super(`Simulation evidence is not configured for ${binCode}.`);
    this.name = "SimulationEvidenceError";
  }
}

export function markSimulatedWorkflowCapture(captureId: string): void {
  simulatedCaptures.add(captureId);
}

export function clearSimulatedWorkflowCapture(captureId: string): void {
  simulatedCaptures.delete(captureId);
}

export function isSimulatedWorkflowCapture(captureId: string): boolean {
  return simulatedCaptures.has(captureId);
}

export function isSimulationEvidenceUrl(url: string | null | undefined): boolean {
  if (url?.startsWith("/audit-simulation/")) return true;
  return Boolean(url?.startsWith("data:image/svg+xml;base64,")
    && Buffer.from(url.split(",")[1], "base64").toString().includes('data-rackhand-simulation="true"'));
}

/** Illustration fallback for B1-02 when no operator-provided reference photo exists. */
function illustratedFrame(binCode: string, quantity: number) {
  if (binCode !== "B1-02") return null;
  if (!Number.isInteger(quantity) || quantity < 0) throw new SimulationEvidenceError(binCode);
  const objects = Array.from({ length: Math.min(quantity, 60) }, (_, index) => {
    const x = 45 + (index % 10) * 43;
    const y = 80 + Math.floor(index / 10) * 35;
    return `<rect x="${x}" y="${y}" width="26" height="20" rx="4" fill="#b7d4e8" stroke="#5c90b0"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-rackhand-simulation="true" width="520" height="360" viewBox="0 0 520 360"><rect width="520" height="360" fill="#111920"/><text x="24" y="30" fill="#9daebc" font-family="sans-serif" font-size="14">SIMULATION · B1-02 · Recorded inventory illustration</text><rect x="24" y="55" width="472" height="260" rx="16" fill="#202e38" stroke="#567084"/>${objects}<text x="24" y="344" fill="#b7d4e8" font-family="sans-serif" font-size="14">${quantity} recorded items · No physical camera or scale reading</text></svg>`;
  const vision: BinInspectionEvidence = {
    countable: true, observedCount: quantity, countConfidence: 1,
    expectedPartPresent: quantity > 0, foreignObjectSuspected: false,
    foreignObjects: [], occlusion: "NONE",
    notes: "Browser simulation based on recorded inventory; no physical camera or scale reading.",
  };
  return { svg, url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, vision };
}

export function simulationIllustrationUrl(binCode: string, quantity: number): string | null {
  return illustratedFrame(binCode, quantity)?.url ?? null;
}

export async function simulationBaselineUrl(binCode: string, quantity = 0): Promise<string | null> {
  const file = path.join(ROOT, binCode, "snapshot.jpg");
  try {
    await access(file);
    return `/audit-simulation/${binCode}/snapshot.jpg`;
  } catch {
    return simulationIllustrationUrl(binCode, quantity);
  }
}

export async function hasSimulationEvidence(binCode: string): Promise<boolean> {
  if (binCode === "B1-02") return true;
  try {
    const files = await readdir(path.join(ROOT, binCode, "pool"));
    return files.some((file) => /\.(jpe?g|png)$/i.test(file));
  } catch {
    return false;
  }
}

/**
 * B1-01 returns curated photos in stable round-robin order for Gemini analysis.
 * B1-02 uses its reference photo (or an illustration fallback) and scripted inspection of recorded stock.
 */
export async function nextSimulationEvidence(binCode: string, quantity = 0): Promise<{
  url: string;
  bytes: Buffer;
  simulatedInspection?: BinInspectionEvidence;
}> {
  const illustration = illustratedFrame(binCode, quantity);
  if (illustration) {
    const baseline = await simulationBaselineUrl(binCode, quantity);
    if (baseline?.startsWith("/audit-simulation/")) {
      return { url: baseline, bytes: await readFile(path.join(ROOT, binCode, "snapshot.jpg")),
        simulatedInspection: { ...illustration.vision,
          notes: "Curated reference photo; browser simulation uses recorded inventory, with no physical camera or scale reading." } };
    }
    return { url: illustration.url, bytes: await sharp(Buffer.from(illustration.svg)).png().toBuffer(),
      simulatedInspection: illustration.vision };
  }
  const dir = path.join(ROOT, binCode, "pool");
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((file) => /\.(jpe?g|png)$/i.test(file))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  } catch {
    throw new SimulationEvidenceError(binCode);
  }
  if (files.length === 0) throw new SimulationEvidenceError(binCode);

  const index = cursors.get(binCode) ?? 0;
  const file = files[index % files.length];
  cursors.set(binCode, (index + 1) % files.length);
  return {
    url: `/audit-simulation/${binCode}/pool/${file}`,
    bytes: await readFile(path.join(dir, file)),
  };
}
