/** Explicit, session-scoped browser demo. Never used by engineering-plan audits
 * or production camera checks. All stock writes still belong to the real
 * retrieval/return transactions; this module supplies simulated evidence only.
 */
import { prisma } from "./db";
import { getAuditCaptureMode, isOutOfSimulationScope } from "./audit-capture-mode";
import { getGantryMode } from "@/lib/gantry/factory";
import type { MaterialRequirement } from "./materials-plan-service";
import type { MaterialsFulfillmentPlan } from "./materials-fulfillment-service";
import type { BinInspectionEvidence } from "./bin-inspection-service";

export const CONTROL_MODULE_BIN_ORDER = ["B4-01", "B3-03", "B6-03"] as const;
const DEMO_TTL_MS = 30 * 60_000;
interface DemoBin {
  code: string;
  sku: string;
  name: string;
  recorded: number;
  checkedOut: number | null;
  returned: number | null;
  foreignObjectRemoved: boolean;
}
interface Demo { expiresAt: number; bins: DemoBin[]; }
const shared = globalThis as typeof globalThis & { controlModuleDemos?: Map<string, Demo> };
const demos = shared.controlModuleDemos ??= new Map<string, Demo>();

export function isControlModulePrompt(message: string): boolean {
  return /^rackhand,?\s+prep the parts for the control module[.!]?$/i.test(message.trim());
}
function demoFor(sessionId: string | null | undefined): Demo | null {
  if (!sessionId || getAuditCaptureMode() !== "SIMULATION" || getGantryMode() !== "SIMULATION") return null;
  const demo = demos.get(sessionId);
  if (demo && demo.expiresAt > Date.now() && !demo.bins.some((bin) => isOutOfSimulationScope(bin.code))) return demo;
  demos.delete(sessionId);
  return null;
}
export function controlModuleRequirements(sessionId: string | null): MaterialRequirement[] | null {
  return demoFor(sessionId)?.bins.map((bin) => ({ sku: bin.sku, purpose: "Control module assembly",
    category: bin.name, quantity: 1 })) ?? null;
}
export function controlModuleScenarioRunning(sessionId: string): boolean {
  return demoFor(sessionId)?.bins.some((bin) => bin.returned === null) ?? false;
}
export function controlModuleCurrentBin(sessionId: string | null): string | null {
  return demoFor(sessionId)?.bins.find((bin) => bin.returned === null)?.code ?? null;
}
export function controlModuleCurrentPart(sessionId: string | null): { binCode: string; sku: string } | null {
  const bin = demoFor(sessionId)?.bins.find((bin) => bin.returned === null);
  return bin ? { binCode: bin.code, sku: bin.sku } : null;
}
export async function beginControlModuleScenario(message: string, sessionId: string | null): Promise<boolean> {
  if (!sessionId || !isControlModulePrompt(message) || getAuditCaptureMode() !== "SIMULATION"
    || getGantryMode() !== "SIMULATION") return false;
  const blockedBin = CONTROL_MODULE_BIN_ORDER.find(isOutOfSimulationScope);
  if (blockedBin) return false;
  const existing = demoFor(sessionId);
  if (existing && existing.bins.some((bin) => bin.checkedOut !== null && bin.returned === null)) {
    throw new Error("Finish the current control module bin before starting another demo.");
  }
  const rows = await prisma.bin.findMany({ where: { code: { in: [...CONTROL_MODULE_BIN_ORDER] } },
    include: { inventory: { include: { part: true } } } });
  const bins = CONTROL_MODULE_BIN_ORDER.map((code): DemoBin => {
    const row = rows.find((bin) => bin.code === code);
    const holding = row?.inventory[0];
    if (!row || row.status !== "OCCUPIED" || row.inventory.length !== 1 || !holding || holding.quantity < 1) {
      throw new Error(`Control module demo requires a stocked shelf bin ${code}. No bin moved.`);
    }
    return { code, sku: holding.part.sku, name: holding.part.canonicalName, recorded: holding.quantity,
      checkedOut: null, returned: null, foreignObjectRemoved: false };
  });
  for (const [key, demo] of demos) if (demo.expiresAt <= Date.now()) demos.delete(key);
  if (!demos.has(sessionId) && demos.size >= 20) throw new Error("Too many active browser demos. Finish an existing demo first.");
  demos.set(sessionId, { expiresAt: Date.now() + DEMO_TTL_MS, bins });
  return true;
}
export function isControlModuleScenarioBin(sessionId: string | null | undefined, code: string): boolean {
  return demoFor(sessionId)?.bins.find((bin) => bin.returned === null)?.code === code;
}
export function controlModuleScenarioPlan(sessionId: string | null): MaterialsFulfillmentPlan | null {
  const demo = demoFor(sessionId);
  if (!demo) return null;
  return { ok: true, requirements: controlModuleRequirements(sessionId)!,
    selectedBins: demo.bins.map((bin) => ({ sku: bin.sku, binCode: bin.code,
      recordedQuantity: bin.recorded, requiredQuantity: 1 })) };
}

export function controlModuleFrame(input: {
  sessionId: string | null | undefined; binCode: string; operation: string; expectedQuantity: number; attempt: number; baseline?: boolean;
}): { svg: string; url: string; vision: BinInspectionEvidence } | null {
  if (!isControlModuleScenarioBin(input.sessionId, input.binCode)) return null;
  const bin = demoFor(input.sessionId)!.bins.find((bin) => bin.code === input.binCode)!;
  const retrieval = input.operation === "RETRIEVAL";
  if (!retrieval && bin.checkedOut === null) throw new Error("Verify checkout before returning this demo bin.");
  const quantity = input.baseline ? input.expectedQuantity : retrieval
    ? input.binCode === "B3-03" ? (input.expectedQuantity >= 3 ? input.expectedQuantity - 2 : input.expectedQuantity + 1) : input.expectedQuantity
    : Math.max(0, bin.checkedOut! - 1);
  const foreign = !input.baseline && retrieval && input.binCode === "B6-03" && input.attempt === 0;
  const visible = Math.min(quantity, 60);
  const objects = Array.from({ length: visible }, (_, index) => {
    const x = 45 + (index % 10) * 43;
    const y = 80 + Math.floor(index / 10) * 35;
    return `<rect x="${x}" y="${y}" width="26" height="20" rx="4" fill="#b7d4e8" stroke="#5c90b0"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="360" viewBox="0 0 520 360"><rect width="520" height="360" fill="#111920"/><text x="24" y="30" fill="#9daebc" font-family="sans-serif" font-size="14">SIMULATED CAMERA · ${input.binCode}</text><rect x="24" y="55" width="472" height="260" rx="16" fill="#202e38" stroke="#567084"/>${objects}${foreign ? '<circle cx="445" cy="275" r="23" fill="#efb34d"/><text x="390" y="312" fill="#efb34d" font-family="sans-serif" font-size="12">Other object</text>' : ""}<text x="24" y="344" fill="#b7d4e8" font-family="sans-serif" font-size="14">${quantity} expected parts · ${foreign ? "unexpected object present" : "contents clear"}</text></svg>`;
  return { svg, url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    vision: { countable: true, observedCount: quantity, countConfidence: 0.95,
      expectedPartPresent: quantity > 0, foreignObjectSuspected: foreign,
      foreignObjects: foreign ? ["unexpected object"] : [], occlusion: "NONE",
      notes: "Scripted browser demonstration; no physical camera or scale evidence." } };
}
export function recordControlModuleCheckout(sessionId: string | null, code: string, quantity: number, attempts: number, recorded?: number): void {
  const bin = demoFor(sessionId)?.bins.find((bin) => bin.code === code);
  if (!bin) return;
  bin.checkedOut = quantity;
  if (recorded !== undefined) bin.recorded = recorded;
  bin.foreignObjectRemoved = code === "B6-03" && attempts > 0;
}
export function recordControlModuleReturn(sessionId: string | null, code: string, quantity: number): void {
  const bin = demoFor(sessionId)?.bins.find((bin) => bin.code === code);
  if (bin) bin.returned = quantity;
}
export function controlModuleFinalReport(sessionId: string | null): string | null {
  const demo = demoFor(sessionId);
  if (!demo || demo.bins.some((bin) => bin.returned === null)) return null;
  return "Control module parts prepared. All 3 bins checked and returned.\n\nBrowser simulation — 1 item taken from each bin.\n\n"
    + demo.bins.map((bin) => `- ${bin.name} · ${bin.code}: recorded ${bin.recorded}, verified ${bin.checkedOut}, remaining ${bin.returned}. Inventory updated.${bin.foreignObjectRemoved ? " Unexpected object removed; retry passed." : ""}`).join("\n");
}
