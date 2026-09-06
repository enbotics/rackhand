/**
 * A deterministic in-memory gantry.
 *
 * Every run of the same sequence produces the same states in the same order:
 * there is no randomness anywhere except the operation id suffix, and
 * failures happen only when explicitly injected. Random failures would make
 * the test suite flaky, so they are not offered.
 *
 * SCOPE — what this deliberately does not do:
 *  - It never reads or writes the warehouse database. No inventory is added
 *    or removed when an operation completes, and no `Movement` row is created
 *    or completed. The gantry executes movement; the warehouse decides what
 *    that means for stock, in a later milestone.
 *  - It validates machine inputs (is this a location I can reach, am I
 *    already busy) and nothing about business state. Whether a bin actually
 *    holds the part being retrieved is not its question.
 *
 * STATE LIFETIME — simulation state is process-local and intended for the
 * local hackathon MVP. It lives in this object's fields, is lost when the
 * Node process restarts, and is not shared across processes. See factory.ts
 * for how a single instance is kept alive across Next.js hot reloads.
 */
import type { GantryController } from "./controller";
import { GantryError } from "./errors";
import {
  isWarehouseBinCode,
  type GantryFailureKind,
  type GantryLocation,
  type GantryOperation,
  type GantryOperationType,
  type GantryState,
  type GantryStatus,
  type PutawayRequest,
  type RetrievalRequest,
  type WarehouseBinCode,
  GANTRY_BIN_CODES,
} from "./types";

/** Short by design — long enough for a dashboard to show progress, short enough for a synchronous API. */
export const DEFAULT_SIM_MOVE_DELAY_MS = 300;
export const DEFAULT_SIM_PICK_DELAY_MS = 200;
export const DEFAULT_SIM_DROP_DELAY_MS = 200;
export const DEFAULT_SIM_HOME_DELAY_MS = 400;
const DEFAULT_HISTORY_LIMIT = 50;

export interface SimulatorOptions {
  moveDelayMs?: number;
  pickDelayMs?: number;
  dropDelayMs?: number;
  homeDelayMs?: number;
  historyLimit?: number;
}

/** One step of a simulated operation. */
interface Phase {
  state: GantryState;
  delayMs: number;
  /** The injected failure kind this phase is vulnerable to, if any. */
  failOn: GantryFailureKind | null;
  /** Where the head has arrived once the phase succeeds. */
  arriveAt?: GantryLocation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `gantry_<timestamp>_<random>` — same shape as the scanner's scan ids. */
function createOperationId(startedAt: number): string {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `gantry_${startedAt}_${suffix}`;
}

/** Quiet under vitest; one line per operation start and end otherwise. */
function log(fields: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[gantry] ${fields}`);
}

export class SimulatedGantryController implements GantryController {
  private state: GantryState = "IDLE";
  private currentLocation: GantryLocation | null = null;
  private homed = false;
  private activeOperation: GantryOperation | null = null;
  private lastError: string | null = null;
  private history: GantryOperation[] = [];
  private pendingFailure: GantryFailureKind | null = null;

  private readonly moveDelayMs: number;
  private readonly pickDelayMs: number;
  private readonly dropDelayMs: number;
  private readonly homeDelayMs: number;
  private readonly historyLimit: number;

  constructor(options: SimulatorOptions = {}) {
    this.moveDelayMs = options.moveDelayMs ?? DEFAULT_SIM_MOVE_DELAY_MS;
    this.pickDelayMs = options.pickDelayMs ?? DEFAULT_SIM_PICK_DELAY_MS;
    this.dropDelayMs = options.dropDelayMs ?? DEFAULT_SIM_DROP_DELAY_MS;
    this.homeDelayMs = options.homeDelayMs ?? DEFAULT_SIM_HOME_DELAY_MS;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  async getStatus(): Promise<GantryStatus> {
    return {
      mode: "SIMULATION",
      state: this.state,
      currentLocation: this.currentLocation,
      homed: this.homed,
      activeOperationId: this.activeOperation?.operationId ?? null,
      lastError: this.lastError,
    };
  }

  async getRecentOperations(limit = 20): Promise<GantryOperation[]> {
    const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, this.historyLimit) : 20;
    return this.history.slice(0, count);
  }

  /* ------------------------------------------------------------ operations */

  async home(): Promise<GantryOperation> {
    const operation = this.claim("HOME", null, null);
    const result = await this.execute(operation, [
      { state: "HOMING", delayMs: this.homeDelayMs, failOn: "movement_timeout" },
    ]);

    if (result.status === "COMPLETED") {
      this.homed = true;
      this.currentLocation = null;
    }
    return result;
  }

  async putaway(input: PutawayRequest): Promise<GantryOperation> {
    const { source, destination } = validatePutaway(input);
    const operation = this.claim("PUTAWAY", source, destination);

    return this.execute(operation, [
      { state: "MOVING", delayMs: this.moveDelayMs, failOn: "movement_timeout", arriveAt: source },
      { state: "PICKING", delayMs: this.pickDelayMs, failOn: "pickup_failed" },
      { state: "MOVING", delayMs: this.moveDelayMs, failOn: null, arriveAt: destination },
      { state: "DROPPING", delayMs: this.dropDelayMs, failOn: "drop_failed" },
    ]);
  }

  async retrieve(input: RetrievalRequest): Promise<GantryOperation> {
    const { source, destination } = validateRetrieval(input);
    const operation = this.claim("RETRIEVAL", source, destination);

    return this.execute(operation, [
      { state: "MOVING", delayMs: this.moveDelayMs, failOn: "movement_timeout", arriveAt: source },
      { state: "PICKING", delayMs: this.pickDelayMs, failOn: "pickup_failed" },
      { state: "MOVING", delayMs: this.moveDelayMs, failOn: null, arriveAt: destination },
      { state: "DROPPING", delayMs: this.dropDelayMs, failOn: "drop_failed" },
    ]);
  }

  /* ---------------------------------------------------- failure injection */

  /**
   * Arms a deterministic failure for the next operation only. It fires at the
   * phase it names (a pickup fails while PICKING); if the next operation has
   * no such phase — `controller_error`, or a pick failure armed before
   * `home()` — it fires immediately at the start instead, so "the next
   * operation fails" always holds. Normal behaviour resumes afterwards.
   */
  failNextOperation(kind: GantryFailureKind): void {
    this.pendingFailure = kind;
  }

  clearFailureInjection(): void {
    this.pendingFailure = null;
  }

  /** Test helper: forget all state, as if the process had just started. */
  reset(): void {
    this.state = "IDLE";
    this.currentLocation = null;
    this.homed = false;
    this.activeOperation = null;
    this.lastError = null;
    this.history = [];
    this.pendingFailure = null;
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Reserves the machine for one operation.
   *
   * Runs to completion synchronously — no `await` between the busy check and
   * the claim — so two overlapping requests can never both win the race, even
   * though the work that follows is asynchronous.
   */
  private claim(
    type: GantryOperationType,
    source: GantryLocation | null,
    destination: GantryLocation | null,
  ): GantryOperation {
    if (this.activeOperation) {
      throw new GantryError(
        "gantry_busy",
        `The gantry is already running ${this.activeOperation.type} operation "${this.activeOperation.operationId}".`,
      );
    }

    const startedAt = Date.now();
    const operation: GantryOperation = {
      operationId: createOperationId(startedAt),
      type,
      source,
      destination,
      status: "RUNNING",
      startedAt,
      completedAt: null,
      error: null,
    };
    this.activeOperation = operation;

    log(
      `operation=${operation.operationId} type=${type} source=${source ?? "-"} destination=${destination ?? "-"} status=RUNNING`,
    );
    return operation;
  }

  private async execute(operation: GantryOperation, phases: Phase[]): Promise<GantryOperation> {
    // Consume the injection up front: it fires once, then normal behaviour
    // resumes even if this operation ends up failing for another reason.
    const injected = this.pendingFailure;
    this.pendingFailure = null;

    if (injected) {
      const reachable = phases.some((phase) => phase.failOn === injected);
      if (!reachable) return this.finish(operation, injected);
    }

    for (const phase of phases) {
      this.state = phase.state;
      await sleep(phase.delayMs);

      // Checked before arriving: a movement that times out never got there.
      if (injected && phase.failOn === injected) return this.finish(operation, injected);
      if (phase.arriveAt !== undefined) this.currentLocation = phase.arriveAt;
    }

    return this.finish(operation, null);
  }

  /**
   * Records the outcome and releases the machine.
   *
   * MVP recovery behaviour: after a failure the controller returns to IDLE
   * rather than latching an ERROR state. The failure is preserved on the
   * operation and in `lastError`, so nothing is lost, and the next valid
   * request can proceed without an explicit clear step.
   */
  private finish(operation: GantryOperation, failure: GantryFailureKind | null): GantryOperation {
    const finished: GantryOperation = {
      ...operation,
      status: failure ? "FAILED" : "COMPLETED",
      completedAt: Date.now(),
      error: failure,
    };

    this.activeOperation = null;
    this.state = "IDLE";
    this.lastError = failure ?? null;

    this.history.unshift(finished);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;

    log(
      `operation=${finished.operationId} type=${finished.type} status=${finished.status}` +
        (failure ? ` error=${failure}` : ""),
    );
    return finished;
  }
}

/* -------------------------------------------------------------- validation */

const BIN_LIST = GANTRY_BIN_CODES.join(", ");

/**
 * Machine-input validation only — never inventory state.
 *
 * The declared parameter type documents intent, but the values are read as
 * `unknown`: these requests arrive from an HTTP body, so the runtime checks
 * have to be real rather than trusting the cast at the route boundary.
 */
export function validatePutaway(input: PutawayRequest): {
  source: "INTAKE";
  destination: WarehouseBinCode;
} {
  const { source, destination } = (input ?? {}) as { source?: unknown; destination?: unknown };

  if (source !== "INTAKE") {
    throw new GantryError(
      "invalid_location",
      `A putaway must start at INTAKE, not "${String(source)}".`,
    );
  }
  if (destination === source) {
    throw new GantryError("invalid_location", "A putaway's source and destination must differ.");
  }
  if (!isWarehouseBinCode(destination)) {
    throw new GantryError(
      "invalid_location",
      `A putaway must end at a known bin (${BIN_LIST}), not "${String(destination)}".`,
    );
  }

  return { source, destination };
}

export function validateRetrieval(input: RetrievalRequest): {
  source: WarehouseBinCode;
  destination: "OUTPUT";
} {
  const { source, destination } = (input ?? {}) as { source?: unknown; destination?: unknown };

  if (destination !== "OUTPUT") {
    throw new GantryError(
      "invalid_location",
      `A retrieval must end at OUTPUT, not "${String(destination)}".`,
    );
  }
  if (source === destination) {
    throw new GantryError("invalid_location", "A retrieval's source and destination must differ.");
  }
  if (!isWarehouseBinCode(source)) {
    throw new GantryError(
      "invalid_location",
      `A retrieval must start at a known bin (${BIN_LIST}), not "${String(source)}".`,
    );
  }

  return { source, destination };
}
