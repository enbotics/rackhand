import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
  return Boolean(url?.startsWith("/audit-simulation/"));
}

export async function simulationBaselineUrl(binCode: string): Promise<string | null> {
  const file = path.join(ROOT, binCode, "snapshot.jpg");
  try {
    await access(file);
    return `/audit-simulation/${binCode}/snapshot.jpg`;
  } catch {
    return null;
  }
}

export async function hasSimulationEvidence(binCode: string): Promise<boolean> {
  try {
    const files = await readdir(path.join(ROOT, binCode, "pool"));
    return files.some((file) => /\.(jpe?g|png)$/i.test(file));
  } catch {
    return false;
  }
}

/**
 * Returns curated demo frames in stable round-robin order. Simulation still
 * exercises the real Gemini analysis, but repeated runs are reproducible and
 * never depend on Math.random().
 */
export async function nextSimulationEvidence(binCode: string): Promise<{
  url: string;
  bytes: Buffer;
}> {
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
