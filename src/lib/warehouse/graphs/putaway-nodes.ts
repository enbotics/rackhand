/**
 * The six deterministic nodes of the putaway workflow (Milestone 11).
 *
 * SERVER ONLY. Every node here is ordinary TypeScript over the existing
 * warehouse services — there is no model call anywhere in this file, and there
 * should never be one. "Is this bin AVAILABLE" is a database row, not an
 * opinion.
 *
 * READ-ONLY EXCEPT ONE. Only `PutawayExecuteNode` calls a mutating service.
 * The other five read authoritative state to route the workflow and to show
 * the operator what is happening; none of them reserves a bin, creates a
 * Movement, touches inventory, or commands the gantry. That is why the whole
 * pre-approval half of this workflow is safe to run.
 *
 * PREFLIGHT IS NOT AUTHORIZATION. Nodes 1-4 answer "does this look like it
 * will work", which is useful for routing and for the dashboard and is
 * worthless as a guarantee — warehouse state can change between this node and
 * the next. `executePutaway` re-runs the matcher, re-checks the bin inside the
 * reserving transaction. A passed preflight never lets the service skip
 * anything.
 */
import { prisma } from "../db";
import { matchScanToCatalog } from "../catalog-matcher";
import { resolveCatalogIdentity } from "../catalog-identity";
import { getBinByCode, listPutawayDestinations } from "../repository";
import { collectScanResultIssues } from "../scan-result";
import { executePutaway } from "../putaway-service";
import {
  MIN_PUTAWAY_QUANTITY_CONFIDENCE,
  PUTAWAY_SOURCE,
  type PutawayResult,
} from "../putaway-types";
import type { ScanResult } from "../scan-types";
import { compareBinsInShelfOrder } from "../bin-layout";
import { PUTAWAY_NODE_IDS } from "./workflow-types";
import {
  createWorkflowRun,
  WorkflowNode,
  type NodeOutcome,
  type WorkflowNodeContext,
  type WorkflowRun,
} from "./workflow-node";

/** What the graph is asked to do. Identical in spirit to `PutawayRequest`. */
export interface PutawayGraphRequest {
  /** Untrusted until the validate node checks it against the Milestone 1 contract. */
  scanResult: unknown;
  imageDataUrl?: string;
  destinationBinCode?: string;
  catalogResolutionId?: string;
}

/**
 * The workflow's shared state.
 *
 * Small on purpose: ids and codes, never whole database rows and never the
 * scan itself. The scan travels once, by reference, in `invocationState`; the
 * graph does not copy it into every node's input.
 */
export interface PutawayGraphData {
  scanId: string;
  partId?: string;
  sku?: string;
  canonicalName?: string;
  identitySource?: "DETERMINISTIC_MATCH" | "HUMAN_RESOLUTION";
  catalogResolutionId?: string;
  destinationBinCode?: string;
  observedQuantity?: number;
  quantityBefore?: number;
  quantityAfter?: number;
  checkedOutReturn?: boolean;
  checkedOutSourceBinCode?: string;
  duplicate?: boolean;
  movementId?: string;
  gantryOperationId?: string;
}

type PutawayContext = WorkflowNodeContext<PutawayGraphRequest, PutawayGraphData>;

/** Where the execute node leaves the service's own result for the runner. */
export const PUTAWAY_SERVICE_RESULT_KEY = "putawayServiceResult";

function scanIdOf(request: PutawayGraphRequest | undefined): string {
  const scan = request?.scanResult as { scanId?: unknown } | undefined;
  return typeof scan?.scanId === "string" ? scan.scanId : "";
}

/* ------------------------------------------------------- 1. VALIDATE */

/**
 * Establishes the workflow and checks the request's shape.
 *
 * Uses the same `collectScanResultIssues` rules as /api/measure and the
 * putaway service, so a scan this node accepts is a scan the service accepts —
 * one contract, not two.
 */
export class PutawayValidateNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.validate, "Validate the scan and the requested destination.");
  }

  protected override seed(request: PutawayGraphRequest): WorkflowRun<PutawayGraphData> {
    const scanId = scanIdOf(request);
    return createWorkflowRun<PutawayGraphData>("PUTAWAY", `wf_putaway_${scanId || "unknown"}`, {
      scanId,
      ...(typeof request?.catalogResolutionId === "string"
        ? { catalogResolutionId: request.catalogResolutionId }
        : {}),
    });
  }

  protected async run({ request, data }: PutawayContext): Promise<NodeOutcome> {
    const issues = collectScanResultIssues(request?.scanResult);
    if (issues.length > 0) {
      return {
        kind: "BLOCKED",
        reason: "invalid_scan",
        message: `The scan is not valid: ${issues.join("; ")}`,
        summary: "The scan does not satisfy the measurement contract.",
      };
    }

    // Shape only. Whether the bin EXISTS and is free is authoritative state,
    // read fresh two nodes from now — asking here would only go stale.
    const destination = request.destinationBinCode;
    if (
      destination !== undefined &&
      (typeof destination !== "string" || destination.trim() === "" || destination.length > 20)
    ) {
      return {
        kind: "BLOCKED",
        reason: "bin_not_found",
        message: "The requested destination bin code is not a usable bin code.",
      };
    }

    const resolutionId = request.catalogResolutionId;
    if (
      resolutionId !== undefined &&
      (typeof resolutionId !== "string" || resolutionId.trim() === "")
    ) {
      return {
        kind: "BLOCKED",
        reason: "catalog_resolution_invalid",
        message: "The supplied identification reference is not usable.",
      };
    }

    data.scanId = (request.scanResult as ScanResult).scanId;
    const existing = await prisma.movement.findUnique({ where: { idempotencyKey: data.scanId } });
    if (existing?.status === "COMPLETED") {
      data.duplicate = true;
      data.observedQuantity = existing.quantity;
      return {
        kind: "PROCEED",
        summary: "This scan already completed and will be replayed without movement.",
      };
    }

    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(request.imageDataUrl ?? "")) {
      return {
        kind: "BLOCKED",
        reason: "photo_required",
        message: "An identified intake scan is required before putaway.",
      };
    }

    data.observedQuantity = (request.scanResult as ScanResult).quantity?.observed ?? 1;
    const confidence = (request.scanResult as ScanResult).quantity?.confidence ?? 1;
    if (confidence < MIN_PUTAWAY_QUANTITY_CONFIDENCE) {
      return {
        kind: "BLOCKED",
        reason: "quantity_confidence_low",
        message: `Quantity confidence must be at least ${Math.round(MIN_PUTAWAY_QUANTITY_CONFIDENCE * 100)}%.`,
      };
    }
    return {
      kind: "PROCEED",
      summary: `Scan ${data.scanId} accepted at ${PUTAWAY_SOURCE}.`,
    };
  }
}

/* ------------------------------------------------------- 2. IDENTITY */

/**
 * Decides which catalog part this is, using the deterministic matcher and —
 * only for an AMBIGUOUS match — a CONFIRMED human resolution.
 *
 * The node never chooses between candidates itself, and it does not trust a
 * supplied part id: `resolveCatalogIdentity` is the same code the putaway
 * service runs, so the answer here and the answer there cannot diverge.
 */
export class PutawayIdentityNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.identity, "Resolve catalog identity deterministically.");
  }

  protected async run({ request, data }: PutawayContext): Promise<NodeOutcome> {
    if (data.duplicate) {
      const movement = await prisma.movement.findUnique({
        where: { idempotencyKey: data.scanId },
        include: { part: true },
      });
      if (!movement) {
        return { kind: "BLOCKED", reason: "putaway_in_progress", message: "The original movement is unavailable." };
      }
      data.partId = movement.part.id;
      data.sku = movement.part.sku;
      data.canonicalName = movement.part.canonicalName;
      data.identitySource = "DETERMINISTIC_MATCH";
      return { kind: "PROCEED", summary: "Original catalog identity restored for replay." };
    }

    const scanResult = request.scanResult as ScanResult;
    const match = await matchScanToCatalog(scanResult);
    const resolved = await resolveCatalogIdentity({
      scanId: data.scanId,
      match,
      catalogResolutionId: request.catalogResolutionId,
    });

    if (!resolved.ok) {
      return { kind: "BLOCKED", reason: resolved.reason, message: resolved.message };
    }

    const part = await prisma.part.findUnique({ where: { id: resolved.identity.partId } });
    if (!part) {
      return {
        kind: "BLOCKED",
        reason: "part_not_found",
        message: "The identified part is no longer in the catalog.",
      };
    }

    data.partId = part.id;
    data.sku = part.sku;
    data.canonicalName = part.canonicalName;
    data.identitySource = resolved.identity.source;

    return {
      kind: "PROCEED",
      summary:
        resolved.identity.source === "HUMAN_RESOLUTION"
          ? `${part.sku} — confirmed by an operator, not by the matcher.`
          : `${part.sku} — matched deterministically.`,
    };
  }
}

/* ---------------------------------------------------- 3. DESTINATION */

/**
 * Chooses where the part goes, WITHOUT reserving anything.
 *
 * Reservation is a transaction that must happen at the moment of execution, so
 * it stays inside `executePutaway` where the conditional update is the lock.
 * Reserving here would hold a bin across the rest of the workflow and create a
 * second place bins can leak from.
 */
export class PutawayDestinationNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.destination, "Choose the destination bin from authoritative state.");
  }

  protected async run({ request, data }: PutawayContext): Promise<NodeOutcome> {
    if (!data.partId || !data.observedQuantity) {
      return { kind: "BLOCKED", reason: "part_not_found", message: "The part or count was not resolved." };
    }

    if (data.duplicate) {
      const movement = await prisma.movement.findUnique({
        where: { idempotencyKey: data.scanId },
        include: { destinationBin: true, sourceBin: true },
      });
      data.destinationBinCode = movement?.destinationBin?.code;
      data.quantityBefore = movement?.previousQuantity ?? 0;
      data.quantityAfter = movement?.newQuantity ?? movement?.quantity;
      data.checkedOutReturn = movement?.sourceLocation === "OUTPUT";
      data.checkedOutSourceBinCode = movement?.sourceBin?.code ?? movement?.destinationBin?.code;
      return { kind: "PROCEED", summary: "Original destination restored from the completed movement." };
    }

    const checkedOutBins = await prisma.bin.findMany({
      where: {
        status: "CHECKED_OUT",
        inventory: { some: { partId: data.partId, quantity: { gt: 0 } } },
      },
      include: { inventory: { where: { partId: data.partId, quantity: { gt: 0 } } } },
    });
    const checkedOut = checkedOutBins.sort(compareBinsInShelfOrder)[0] ?? null;

    if (request.destinationBinCode !== undefined) {
      const bin = await getBinByCode(request.destinationBinCode);
      if (!bin) {
        return {
          kind: "BLOCKED",
          reason: "bin_not_found",
          message: `No bin has code "${request.destinationBinCode}".`,
        };
      }
      const contents = await prisma.inventory.findMany({
        where: { binId: bin.id, quantity: { gt: 0 } },
        select: { partId: true, quantity: true },
      });
      const before = contents.reduce((sum, row) => sum + row.quantity, 0);
      if (bin.status === "CHECKED_OUT") {
        if (
          contents.length === 0 ||
          contents.some((row) => row.partId !== data.partId) ||
          data.observedQuantity > bin.capacity
        ) {
          return { kind: "BLOCKED", reason: "bin_unavailable", message: `Checked-out bin ${bin.code} is not compatible with this return.` };
        }
        data.checkedOutReturn = true;
        data.checkedOutSourceBinCode = bin.code;
        data.quantityBefore = before;
        data.quantityAfter = data.observedQuantity;
      } else if (checkedOut) {
        const checkoutBefore = checkedOut.inventory.reduce((sum, row) => sum + row.quantity, 0);
        if (bin.status !== "AVAILABLE" || before !== 0 || data.observedQuantity > bin.capacity) {
          return {
            kind: "BLOCKED",
            reason: data.observedQuantity > bin.capacity ? "bin_capacity_exceeded" : "bin_unavailable",
            message: `Alternate return slot ${bin.code} must be empty, AVAILABLE and able to hold ${data.observedQuantity} units.`,
          };
        }
        data.checkedOutReturn = true;
        data.checkedOutSourceBinCode = checkedOut.code;
        data.quantityBefore = checkoutBefore;
        data.quantityAfter = data.observedQuantity;
      } else {
        const destinations = await listPutawayDestinations(data.partId, data.observedQuantity);
        const candidate = destinations.find((item) => item.code === bin.code);
        if (!candidate?.eligible) {
          return { kind: "BLOCKED", reason: candidate?.reason === "FULL" ? "bin_capacity_exceeded" : "bin_unavailable", message: `Bin ${bin.code} is not compatible (${candidate?.reason ?? bin.status}).` };
        }
        data.checkedOutReturn = false;
        data.quantityBefore = candidate.currentQuantity;
        data.quantityAfter = candidate.afterQuantity;
      }
      data.destinationBinCode = bin.code;
      return { kind: "PROCEED", summary: `${bin.code}: ${data.quantityBefore} → ${data.quantityAfter}.` };
    }

    if (checkedOut && data.observedQuantity <= checkedOut.capacity) {
      const before = checkedOut.inventory.reduce((sum, row) => sum + row.quantity, 0);
      data.destinationBinCode = checkedOut.code;
      data.checkedOutReturn = true;
      data.checkedOutSourceBinCode = checkedOut.code;
      data.quantityBefore = before;
      data.quantityAfter = data.observedQuantity;
      return { kind: "PROCEED", summary: `${checkedOut.code} is the checked-out home bin; camera reconciliation ${before} → ${data.observedQuantity}.` };
    }

    const destinations = await listPutawayDestinations(data.partId, data.observedQuantity);
    const chosen = checkedOut
      ? destinations.find(
          (item) => item.eligible && item.status === "AVAILABLE" && item.currentQuantity === 0,
        )
      : destinations.find((item) => item.eligible && item.alreadyStoresPart) ??
        destinations.find((item) => item.eligible);
    if (!chosen) {
      return {
        kind: "BLOCKED",
        reason: "no_available_bin",
        message: `No compatible bin has capacity for ${data.observedQuantity} units.`,
      };
    }
    data.destinationBinCode = chosen.code;
    data.checkedOutReturn = Boolean(checkedOut);
    data.checkedOutSourceBinCode = checkedOut?.code;
    data.quantityBefore = checkedOut
      ? checkedOut.inventory.reduce((sum, row) => sum + row.quantity, 0)
      : chosen.currentQuantity;
    data.quantityAfter = checkedOut ? data.observedQuantity : chosen.afterQuantity;
    return { kind: "PROCEED", summary: `${chosen.code} chosen; capacity ${chosen.currentQuantity} → ${chosen.afterQuantity}/${chosen.capacity}.` };
  }
}

/* ------------------------------------------------------ 4. PREFLIGHT */

/**
 * Read-only "does this still look executable" check.
 *
 * Advisory by design. Everything it looks at is re-checked by the service
 * moments later, and the gap between the two is exactly where a race lives —
 * which is the point of the service re-checking.
 */
export class PutawayPreflightNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.preflight, "Read-only readiness check before execution.");
  }

  protected async run({ data }: PutawayContext): Promise<NodeOutcome> {
    if (data.duplicate) {
      return { kind: "PROCEED", summary: "No gantry preflight is needed for an idempotent replay." };
    }
    const part = data.partId ? await prisma.part.findUnique({ where: { id: data.partId } }) : null;
    if (!part) {
      return {
        kind: "BLOCKED",
        reason: "part_not_found",
        message: "The identified part is no longer in the catalog.",
      };
    }

    const bin = data.destinationBinCode ? await getBinByCode(data.destinationBinCode) : null;
    if (!bin) {
      return {
        kind: "BLOCKED",
        reason: "bin_not_found",
        message: `No bin has code "${data.destinationBinCode}".`,
      };
    }
    const relocatingCheckout =
      data.checkedOutReturn && data.checkedOutSourceBinCode !== data.destinationBinCode;
    if (
      data.checkedOutReturn
        ? relocatingCheckout
          ? bin.status !== "AVAILABLE"
          : bin.status !== "CHECKED_OUT"
        : !["AVAILABLE", "OCCUPIED"].includes(bin.status)
    ) {
      return {
        kind: "BLOCKED",
        reason: "bin_unavailable",
        message: `Bin ${bin.code} changed to ${bin.status} before execution.`,
      };
    }
    if (relocatingCheckout) {
      const source = data.checkedOutSourceBinCode
        ? await getBinByCode(data.checkedOutSourceBinCode)
        : null;
      if (!source || source.status !== "CHECKED_OUT") {
        return {
          kind: "BLOCKED",
          reason: "bin_unavailable",
          message: `The checked-out source ${data.checkedOutSourceBinCode ?? "bin"} is no longer ready to return.`,
        };
      }
    }

    // A conflicting workflow already holds this scan. A COMPLETED one is NOT a
    // conflict — that is the idempotent replay the service is designed to
    // return, so it is allowed through to be answered there.
    const claimed = await prisma.movement.findUnique({
      where: { idempotencyKey: data.scanId },
    });
    if (claimed && claimed.status !== "COMPLETED") {
      return {
        kind: "BLOCKED",
        reason: "putaway_in_progress",
        message:
          "This scan is already being put away. Wait for it to finish rather than submitting it again.",
      };
    }

    return {
      kind: "PROCEED",
      summary: `${part.sku} → ${bin.code}.`,
    };
  }
}

/* -------------------------------------------------------- 5. EXECUTE */

/**
 * The ONLY node in this graph permitted to change warehouse state, and it does
 * so by asking `executePutaway` — it reproduces none of the reservation,
 * Movement lifecycle, gantry call or inventory arithmetic itself.
 *
 * The service revalidates everything from scratch. If it refuses because the
 * bin was taken between preflight and here, that refusal stands: the graph
 * reports the failure and never overrides the service because an earlier node
 * saw a greener warehouse.
 */
export class PutawayExecuteNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.execute, "Ask PutawayService to validate and execute.");
  }

  protected async run(context: PutawayContext): Promise<NodeOutcome> {
    const { request, data } = context;
    const result: PutawayResult = await executePutaway({
      scanResult: request.scanResult as ScanResult,
      imageDataUrl: request.imageDataUrl,
      destinationBinCode: data.destinationBinCode,
      catalogResolutionId: request.catalogResolutionId,
    });

    // Handed back to the runner so the Strands tool can return the unchanged
    // Milestone 7 contract to the agent.
    context.invocationState[PUTAWAY_SERVICE_RESULT_KEY] = result;

    if (!result.ok) {
      // Keep the ids a failed attempt DID produce. A putaway that reached the
      // machine and failed there has a Movement and a GantryOperation to
      // reconcile against, and losing them here would leave the workflow
      // result — and the trace built from it — unable to name what happened.
      if (result.movementId) data.movementId = result.movementId;
      if (result.gantryOperationId) data.gantryOperationId = result.gantryOperationId;
      return {
        kind: "FAILED",
        reason: result.reason,
        message: result.message,
        summary: `Refused by PutawayService: ${result.reason}.`,
        ...(result.movementId ? { movementId: result.movementId } : {}),
        ...(result.gantryOperationId ? { gantryOperationId: result.gantryOperationId } : {}),
      };
    }

    data.movementId = result.movementId;
    data.gantryOperationId = result.gantryOperationId;
    data.destinationBinCode = result.destinationBinCode;
    data.partId = result.part.partId;
    data.sku = result.part.sku;
    data.identitySource = result.identity.source;
    if (result.reconciledCheckout) {
      const committedMovement = await prisma.movement.findUnique({
        where: { id: result.movementId },
        include: { sourceBin: true, destinationBin: true },
      });
      data.checkedOutReturn = true;
      data.checkedOutSourceBinCode =
        committedMovement?.sourceBin?.code ?? committedMovement?.destinationBin?.code;
    }

    return {
      kind: "PROCEED",
      summary: result.duplicate
        ? `Already completed for this scan; nothing was executed again.`
        : `${result.part.sku} stored in ${result.destinationBinCode}.`,
    };
  }
}

/* --------------------------------------------------------- 6. VERIFY */

/**
 * Read-only coherence check on what the service just committed.
 *
 * It REPORTS, it does not repair. If the movement is not COMPLETED or the
 * stock is not where it should be, that is an anomaly a person must look at;
 * writing corrective rows here would hide the bug, and re-running the gantry
 * would move a part that has already been moved.
 */
export class PutawayVerifyNode extends WorkflowNode<PutawayGraphRequest, PutawayGraphData> {
  constructor() {
    super(PUTAWAY_NODE_IDS.verify, "Confirm the committed state is coherent. Read-only.");
  }

  protected async run({ data, invocationState }: PutawayContext): Promise<NodeOutcome> {
    const result = invocationState[PUTAWAY_SERVICE_RESULT_KEY] as PutawayResult | undefined;
    const problems: string[] = [];

    const movement = data.movementId
      ? await prisma.movement.findUnique({ where: { id: data.movementId } })
      : null;
    if (!movement) {
      problems.push("the movement record is missing");
    } else if (movement.status !== "COMPLETED") {
      problems.push(`the movement is ${movement.status}, not COMPLETED`);
    }

    if (result?.ok && result.duplicate) {
      return problems.length > 0
        ? {
            kind: "FAILED",
            reason: "verification_failed",
            message: `The original movement cannot be replayed coherently: ${problems.join("; ")}.`,
          }
        : { kind: "PROCEED", summary: "Original completed putaway replayed; no current state was changed." };
    }

    const bin = data.destinationBinCode ? await getBinByCode(data.destinationBinCode) : null;
    if (!bin) {
      problems.push("the destination bin is missing");
    } else if (bin.status !== "OCCUPIED") {
      problems.push(`bin ${bin.code} is ${bin.status}, not OCCUPIED`);
    }

    if (bin && data.partId) {
      const stock = await prisma.inventory.findUnique({
        where: { partId_binId: { partId: data.partId, binId: bin.id } },
      });
      if (!stock || (result?.ok && stock.quantity !== result.inventoryQuantityAfter)) {
        problems.push(
          `inventory in ${bin.code} does not equal the committed count ${result?.ok ? result.inventoryQuantityAfter : "unknown"}`,
        );
      }
    }

    if (
      data.checkedOutReturn &&
      data.checkedOutSourceBinCode &&
      data.checkedOutSourceBinCode !== data.destinationBinCode
    ) {
      const source = await getBinByCode(data.checkedOutSourceBinCode);
      const sourceStock = source
        ? await prisma.inventory.findUnique({
            where: { partId_binId: { partId: data.partId!, binId: source.id } },
          })
        : null;
      if (!source || source.status !== "AVAILABLE" || sourceStock) {
        problems.push(`the old slot ${data.checkedOutSourceBinCode} was not released cleanly`);
      }
    }

    if (problems.length > 0) {
      return {
        kind: "FAILED",
        reason: "verification_failed",
        message:
          `The putaway reported success but the warehouse state is not coherent: ${problems.join("; ")}. ` +
          "Nothing was changed to compensate; this needs manual reconciliation.",
        summary: "Committed state failed verification.",
        ...(data.movementId ? { movementId: data.movementId } : {}),
        ...(data.gantryOperationId ? { gantryOperationId: data.gantryOperationId } : {}),
      };
    }

    return {
      kind: "PROCEED",
      summary: `Movement COMPLETED; ${data.destinationBinCode} holds ${result?.ok ? result.inventoryQuantityAfter : "verified"} ${data.sku}.`,
    };
  }
}
