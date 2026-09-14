import { randomUUID } from "node:crypto";
import type { GantryController } from "./controller";
import { GantryError } from "./errors";
import { validateAuditBin, validateBinPresentation, validateBinReturn, validatePutaway, validateRetrieval } from "./simulator";
import { parseBinCode } from "@/lib/warehouse/types";
import type { AuditBinRequest, BinPresentationRequest, BinReturnRequest, GantryLocation,
  GantryOperation, GantryOperationType, GantryStatus, PutawayRequest, RetrievalRequest } from "./types";

export type KlipperMacroAction = "home" | "putaway" | "retrieve" | "presentBin" | "returnBin" | "auditPresent" | "auditReturn";
const DEFAULT_MACROS: Record<KlipperMacroAction, string> = {
  home: "RACKHAND_HOME", putaway: "RACKHAND_PUTAWAY", retrieve: "RACKHAND_RETRIEVE",
  presentBin: "RACKHAND_RETRIEVE", returnBin: "RACKHAND_RETURN",
  auditPresent: "RACKHAND_RETRIEVE", auditReturn: "RACKHAND_RETURN",
};
const MACRO_ENV: Record<KlipperMacroAction, string> = {
  home: "KLIPPER_HOME_MACRO", putaway: "KLIPPER_PUTAWAY_MACRO", retrieve: "KLIPPER_RETRIEVE_MACRO",
  presentBin: "KLIPPER_PRESENT_BIN_MACRO", returnBin: "KLIPPER_RETURN_BIN_MACRO",
  auditPresent: "KLIPPER_AUDIT_PRESENT_MACRO", auditReturn: "KLIPPER_AUDIT_RETURN_MACRO",
};

export interface KlipperOptions {
  baseUrl: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  macros?: Partial<Record<KlipperMacroAction, string>>;
  /** Tests supply an HTTP transport; application code uses server-side fetch. */
  fetch?: typeof fetch;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new GantryError("gantry_configuration_invalid", "Klipper timeouts must be positive integers in milliseconds.");
  }
  return result;
}

export function readKlipperOptions(): KlipperOptions {
  return {
    baseUrl: process.env.KLIPPER_BASE_URL?.trim() ?? "",
    apiKey: process.env.KLIPPER_API_KEY?.trim() || undefined,
    requestTimeoutMs: process.env.KLIPPER_REQUEST_TIMEOUT_MS === undefined ? undefined : Number(process.env.KLIPPER_REQUEST_TIMEOUT_MS),
    statusTimeoutMs: process.env.KLIPPER_STATUS_TIMEOUT_MS === undefined ? undefined : Number(process.env.KLIPPER_STATUS_TIMEOUT_MS),
    macros: Object.fromEntries(Object.entries(MACRO_ENV).map(([action, name]) => [action, process.env[name]?.trim() ?? DEFAULT_MACROS[action as KlipperMacroAction]])),
  };
}

interface PrinterState { ready: boolean; homed: boolean; busy: boolean }

/** Macro execution reports machine outcomes only. Warehouse services own inventory. */
export class KlipperGantryController implements GantryController {
  private readonly baseUrl: URL;
  private readonly transport: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly macros: Record<KlipperMacroAction, string>;
  private readonly headers: Record<string, string>;
  private executing = false;
  private activeOperation: GantryOperation | null = null;
  private history: GantryOperation[] = [];
  private currentLocation: GantryLocation | null = null;
  private homed = false;
  private lastError: string | null = null;
  private reconciliationRequired = false;

  constructor(options: KlipperOptions) {
    try {
      this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
      if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password
        || this.baseUrl.search || this.baseUrl.hash) throw new Error("Invalid URL");
    } catch {
      throw new GantryError("gantry_configuration_invalid", "KLIPPER_BASE_URL must be the HTTP(S) Moonraker API URL without credentials, query or fragment.");
    }
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 90_000);
    this.statusTimeoutMs = positiveTimeout(options.statusTimeoutMs, 5_000);
    this.macros = { ...DEFAULT_MACROS, ...options.macros };
    for (const [action, name] of Object.entries(this.macros)) {
      if (!/^[A-Z_]+[0-9]*$/i.test(name)) {
        throw new GantryError("gantry_configuration_invalid", `The Klipper ${action} binding must be one macro name, without parameters or G-code lines.`);
      }
      this.macros[action as KlipperMacroAction] = name.toUpperCase();
    }
    this.transport = options.fetch ?? globalThis.fetch;
    this.headers = { "Content-Type": "application/json", ...(options.apiKey ? { "X-Api-Key": options.apiKey } : {}) };
  }

  async getStatus(): Promise<GantryStatus> {
    try {
      const printer = await this.readPrinterState();
      return this.status(this.reconciliationRequired || !printer.ready ? "ERROR"
        : this.activeOperation ? this.activeOperation.type === "HOME" ? "HOMING" : "MOVING"
          : printer.busy ? "MOVING" : "IDLE", !printer.ready ? "Klipper is not ready. Check its shutdown or startup state." : undefined);
    } catch {
      return this.status(this.reconciliationRequired ? "ERROR" : "OFFLINE", "Klipper is unavailable. Check Moonraker connection and authentication.");
    }
  }

  async getRecentOperations(limit = 20): Promise<GantryOperation[]> {
    return this.history.slice(0, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20).map((operation) => ({ ...operation }));
  }

  home(): Promise<GantryOperation> {
    return this.execute("HOME", "home", null, null);
  }
  putaway(input: PutawayRequest): Promise<GantryOperation> {
    const { source, destination } = validatePutaway(input);
    return this.execute("PUTAWAY", "putaway", source, destination, destination, source);
  }
  retrieve(input: RetrievalRequest): Promise<GantryOperation> {
    const { source, destination } = validateRetrieval(input);
    return this.execute("RETRIEVAL", "retrieve", source, destination, source, destination);
  }
  presentBin(input: BinPresentationRequest): Promise<GantryOperation> {
    const { source, destination } = validateBinPresentation(input);
    return this.execute("BIN_PRESENTATION", "presentBin", source, destination, source, destination);
  }
  returnBin(input: BinReturnRequest): Promise<GantryOperation> {
    const { source, destination } = validateBinReturn(input);
    return this.execute("BIN_RETURN", "returnBin", source, destination, destination, source);
  }
  presentBinForAudit(input: AuditBinRequest): Promise<GantryOperation> {
    const binCode = validateAuditBin(input);
    return this.execute("AUDIT_PRESENTATION", "auditPresent", binCode, "SCAN_STATION", binCode, "SCAN_STATION");
  }
  returnBinFromAudit(input: AuditBinRequest): Promise<GantryOperation> {
    const binCode = validateAuditBin(input);
    return this.execute("AUDIT_RETURN", "auditReturn", "SCAN_STATION", binCode, binCode, "SCAN_STATION");
  }

  private status(state: GantryStatus["state"], error?: string): GantryStatus {
    return { mode: "PRODUCTION", state, homed: this.homed, currentLocation: this.currentLocation,
      activeOperationId: this.activeOperation?.operationId ?? null,
      lastError: this.lastError ?? error ?? null,
      operation: this.activeOperation ? { ...this.activeOperation } : this.history[0] ? { ...this.history[0] } : null,
      carrying: false, motion: null };
  }

  private async request(path: string, timeoutMs: number, script?: string): Promise<unknown> {
    const response = await this.transport(new URL(path, this.baseUrl), {
      method: script === undefined ? "GET" : "POST", headers: this.headers,
      ...(script === undefined ? {} : { body: JSON.stringify({ script }) }),
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "error",
    });
    if (!response.ok) throw new GantryError("gantry_offline", `Moonraker returned HTTP ${response.status}. Check its API URL and server authentication.`);
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "error" in data) throw new Error("Moonraker rejected the request.");
    return data && typeof data === "object" && "result" in data ? data.result : data;
  }

  private async readPrinterState(): Promise<PrinterState> {
    const data = await this.request("printer/objects/query?webhooks&toolhead&idle_timeout", this.statusTimeoutMs);
    if (!data || typeof data !== "object" || !("status" in data) || !data.status || typeof data.status !== "object") {
      throw new GantryError("gantry_offline", "Moonraker did not return printer status.");
    }
    const status = data.status as { webhooks?: { state?: unknown }; toolhead?: { homed_axes?: unknown }; idle_timeout?: { state?: unknown } };
    if (typeof status.webhooks?.state !== "string" || typeof status.toolhead?.homed_axes !== "string"
      || !["Idle", "Ready", "Printing"].includes(String(status.idle_timeout?.state))) {
      throw new GantryError("gantry_offline", "Moonraker must report webhooks, toolhead homed_axes and idle_timeout state.");
    }
    this.homed = ["x", "y", "z"].every((axis) => (status.toolhead!.homed_axes as string).includes(axis));
    return { ready: status.webhooks.state === "ready", homed: this.homed, busy: status.idle_timeout?.state === "Printing" };
  }

  private async execute(type: GantryOperationType, action: KlipperMacroAction, source: GantryLocation | null,
    destination: GantryLocation | null, binCode?: string, station?: string): Promise<GantryOperation> {
    const bin = binCode === undefined ? null : parseBinCode(binCode);
    if (binCode !== undefined && !bin) throw new GantryError("invalid_location", "The Klipper bin must be a configured rack position B1-01 through B6-05.");
    if (this.reconciliationRequired) throw new GantryError("gantry_reconciliation_required", "The last Klipper movement needs manual reconciliation before another move. Check the machine and bin, then restart RackHand.");
    if (this.executing) throw new GantryError("gantry_busy", "Klipper is already executing a RackHand operation.");
    // Claim synchronously before the first request, including preflight, to prevent overlapping commands.
    this.executing = true;
    try {
      const printer = await this.readPrinterState().catch(() => {
        throw new GantryError("gantry_offline", "Cannot read Klipper status. No movement command was sent; check Moonraker connection and authentication.");
      });
      if (!printer.ready) throw new GantryError("gantry_not_ready", "Klipper must be ready before gantry movement.");
      if (printer.busy) throw new GantryError("gantry_busy", "Klipper is processing another movement. Wait until it is idle.");
      if (type !== "HOME" && !printer.homed) throw new GantryError("gantry_not_ready", "Home the Klipper X, Y and Z axes before moving bins.");
      const operation: GantryOperation = { operationId: `gantry_${Date.now()}_${randomUUID()}`, type, source, destination,
        status: "RUNNING", startedAt: Date.now(), completedAt: null, error: null };
      this.activeOperation = operation;
      const script = `${this.macros[action]}${bin ? ` BIN=${binCode} BED=${bin.bed} SLOT=${bin.slot} STATION=${station}` : ""}\nM400`;
      let error: string | null = null;
      try {
        if (await this.request("printer/gcode/script", this.requestTimeoutMs, script) !== "ok") throw new Error("Unexpected macro acknowledgement");
        const after = await this.readPrinterState();
        if (!after.ready || !after.homed) throw new Error("Klipper was not ready and homed after the macro");
        // Return/putaway macros must park the unloaded carriage at home after shelving the bin.
        this.currentLocation = type === "HOME" || ["PUTAWAY", "BIN_RETURN", "AUDIT_RETURN"].includes(type) ? null : destination;
        this.lastError = null;
      } catch (failure) {
        error = failure instanceof Error && ["TimeoutError", "AbortError"].includes(failure.name) ? "movement_timeout" : "controller_error";
        this.currentLocation = null;
        this.reconciliationRequired = true;
        this.lastError = "Klipper movement failed or its completion is uncertain. No automatic retry was sent; inspect the machine and reconcile the bin.";
      }
      const finished: GantryOperation = { ...operation, status: error ? "FAILED" : "COMPLETED", completedAt: Date.now(), error,
        ...(error ? { reconciliationRequired: true } : {}) };
      this.history.unshift(finished);
      this.history.length = Math.min(this.history.length, 50);
      return { ...finished };
    } finally {
      this.activeOperation = null;
      this.executing = false;
    }
  }
}
