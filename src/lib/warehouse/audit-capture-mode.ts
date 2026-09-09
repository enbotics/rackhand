/**
 * Runtime toggle for how an inventory audit gets its photo: a Raspberry Pi
 * capture (PROD) or a sampled stand-in from a bin's curated local demo
 * photos (SIMULATION) — see simulateCapture() in audit-bin-service.ts.
 *
 * This used to be decided ONLY by the AUDIT_CAPTURE_MODE env var, which meant
 * flipping it required editing .env and restarting the dev server — not
 * something an operator can do from the Warehouse page. AUDIT_CAPTURE_MODE
 * now only supplies the STARTING value; the toggle in the UI (next to
 * "Manage bins") overrides it live for the rest of the process's life.
 *
 * PROCESS-LOCAL, same idiom as the gantry controller singleton in
 * lib/gantry/factory.ts: cached on globalThis so Next.js hot reloads and
 * separate route modules share one value instead of each getting its own
 * copy of the env default. Not shared across processes or server instances,
 * does not survive a restart — acceptable here because losing it just means
 * the next process boots back to the env-configured default, never to a
 * silently-wrong mode.
 */
export type AuditCaptureMode = "PROD" | "SIMULATION";

function envDefault(): AuditCaptureMode {
  return process.env.AUDIT_CAPTURE_MODE?.trim().toUpperCase() === "SIMULATION" ? "SIMULATION" : "PROD";
}

const globalForAuditMode = globalThis as unknown as { auditCaptureMode?: AuditCaptureMode };

export function getAuditCaptureMode(): AuditCaptureMode {
  return globalForAuditMode.auditCaptureMode ?? envDefault();
}

export function setAuditCaptureMode(mode: AuditCaptureMode): void {
  globalForAuditMode.auditCaptureMode = mode;
}

export function isAuditCaptureMode(value: unknown): value is AuditCaptureMode {
  return value === "PROD" || value === "SIMULATION";
}

/**
 * Simulation only ever applies to these bins, regardless of the toggle
 * above — every other bin always uses the real camera. Each one gets a
 * curated local folder (public/audit-simulation/<BIN>/) with one snapshot
 * photo and a pool of stand-in captures; flipping the toggle to SIMULATION
 * for a bin with no such folder would have nothing real to show, so scoping
 * it to bins that are actually set up for it keeps every other bin honest.
 */
export const SIMULATION_ELIGIBLE_BINS = ["B1-01", "B2-02"];

export function isSimulationEligibleBin(binCode: string): boolean {
  return SIMULATION_ELIGIBLE_BINS.includes(binCode.toUpperCase());
}

/**
 * True when the global toggle is SIMULATION but this specific bin is NOT on
 * the eligible list — meaning an operation here would silently fall through
 * to the real Raspberry Pi camera and a real inventory write, even though
 * the operator believes the app is in a safe demo mode. Callers must refuse
 * the operation in this case (see SimulationScopeError) rather than let it
 * proceed unannounced.
 */
export function isOutOfSimulationScope(binCode: string): boolean {
  return getAuditCaptureMode() === "SIMULATION" && !isSimulationEligibleBin(binCode);
}

export class SimulationScopeError extends Error {
  constructor(binCode: string) {
    super(
      `Bin ${binCode} is not simulation-eligible (only ${SIMULATION_ELIGIBLE_BINS.join(", ")} are). ` +
        "Switch Audit Capture Mode to Prod to operate on this bin.",
    );
    this.name = "SimulationScopeError";
  }
}

/**
 * Simulation resolves from a cached demo photo plus one Gemini call — often
 * under a second — and no capture popup ever opens for it (simulation skips
 * creating that row entirely, see SIMULATION_ELIGIBLE_BINS above), so an
 * instant result reads as "nothing happened" rather than "the demo camera
 * has no UI." Padding it out to a believable capture-and-analyze duration is
 * purely cosmetic — callers should time from just before the simulated work
 * starts and await this before returning the result.
 */
export const SIMULATED_CAPTURE_MIN_DURATION_MS = 3_000;

export async function waitOutSimulatedCaptureDuration(startedAt: number): Promise<void> {
  const remaining = SIMULATED_CAPTURE_MIN_DURATION_MS - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
