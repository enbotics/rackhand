/**
 * The seven deterministic nodes of the retrieval workflow (Milestone 11).
 *
 * SERVER ONLY, and — like the putaway nodes — entirely free of model calls.
 * "Is there stock" and "which bin" are queries, not questions for a language
 * model.
 *
 * READ-ONLY EXCEPT ONE. Only `RetrievalExecuteNode` calls a mutating service.
 * Nothing else here creates a Movement, changes bin availability or commands
 * the gantry.
 *
 * The distinction the brief cares most about is kept explicit: an unknown part
 * and a known part with no stock are different answers, produced by different
 * nodes, with different reasons.
 */
import { prisma } from "../db";
import { getInventoryByBin, getInventoryForPart } from "../inventory-service";
import { retrievalStockIssue } from "../retrieval-stock";
import { getBinByCode, getPartById, getPartBySku } from "../repository";
import {
  chooseRetrievalSourceBinCode,
  createRetrievalRequestId,
  executeRetrieval,
  RETRIEVAL_IDEMPOTENCY_PREFIX,
} from "../retrieval-service";
import {
  RETRIEVAL_DESTINATION,
  type RetrievalResult,
} from "../retrieval-types";
import { RETRIEVAL_NODE_IDS } from "./workflow-types";
import {
  createWorkflowRun,
  WorkflowNode,
  type NodeOutcome,
  type WorkflowNodeContext,
  type WorkflowRun,
} from "./workflow-node";

/** What the graph is asked to do. Mirrors `RetrievalRequest`. */
export interface RetrievalGraphRequest {
  verifyContents?: boolean;
  sku?: string;
  partId?: string;
  /** Deprecated compatibility input. Retrieval checks out the entire bin. */
  quantity?: number;
  sourceBinCode?: string;
  requestId?: string;
}

export interface RetrievalGraphData {
  requestId: string;
  partId?: string;
  sku?: string;
  canonicalName?: string;
  sourceBinCode?: string;
  /** Last-known stock kept while the whole bin is checked out. */
  sourceQuantityBefore?: number;
  duplicate?: boolean;
  movementId?: string;
  gantryOperationId?: string;
}

type RetrievalContext = WorkflowNodeContext<RetrievalGraphRequest, RetrievalGraphData>;

/** Where the execute node leaves the service's own result for the runner. */
export const RETRIEVAL_SERVICE_RESULT_KEY = "retrievalServiceResult";

/* ------------------------------------------------------- 1. VALIDATE */

/**
 * Establishes the workflow and checks the request's shape.
 *
 * The request id is settled HERE rather than left to the service, so preflight
 * can check the same idempotency key the service will claim, and so the
 * workflow has a stable id to report. Supplying one is what makes a retry
 * idempotent; generating one keeps a single call safe.
 */
export class RetrievalValidateNode extends WorkflowNode<
  RetrievalGraphRequest,
  RetrievalGraphData
> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.validate, "Validate the retrieval request and settle its id.");
  }

  protected override seed(request: RetrievalGraphRequest): WorkflowRun<RetrievalGraphData> {
    const requestId =
      typeof request?.requestId === "string" && request.requestId.trim() !== ""
        ? request.requestId.trim()
        : createRetrievalRequestId();
    return createWorkflowRun<RetrievalGraphData>("RETRIEVAL", `wf_retrieval_${requestId}`, {
      requestId,
    });
  }

  protected async run({ request, data }: RetrievalContext): Promise<NodeOutcome> {
    const sku = typeof request?.sku === "string" ? request.sku.trim() : "";
    const partId = typeof request?.partId === "string" ? request.partId.trim() : "";
    const source = request.sourceBinCode;
    if (source !== undefined && (typeof source !== "string" || source.trim() === "")) {
      return {
        kind: "BLOCKED",
        reason: "source_bin_not_found",
        message: "The requested source bin code is not a usable bin code.",
      };
    }
    if (sku && partId) {
      return {
        kind: "BLOCKED",
        reason: "invalid_request",
        message: "Provide at most one of sku or partId, not both.",
      };
    }
    // Neither sku nor partId is fine when a bin was named — the bin IS the
    // identity in that case (see RetrievalPartNode), never a guess.
    if (!sku && !partId && !source) {
      return {
        kind: "BLOCKED",
        reason: "invalid_request",
        message: "Provide a sku, a partId, or a sourceBinCode to identify what to retrieve.",
      };
    }

    const existing = await prisma.movement.findUnique({
      where: { idempotencyKey: `${RETRIEVAL_IDEMPOTENCY_PREFIX}${data.requestId}` },
    });
    data.duplicate = existing?.status === "COMPLETED";

    return {
      kind: "PROCEED",
      summary: data.duplicate
        ? "This request already completed and will be replayed without movement."
        : sku || partId
          ? `The bin holding ${sku || partId} will be checked out to ${RETRIEVAL_DESTINATION}.`
          : `Bin ${source!.trim().toUpperCase()} will be checked out to ${RETRIEVAL_DESTINATION}.`,
    };
  }
}

/* ----------------------------------------------------------- 2. PART */

/**
 * Resolves authoritative catalog identity from a SKU or a part id.
 *
 * "No such part" is deliberately its own answer, distinct from "none in
 * stock" — an operator hearing the wrong one goes looking in the wrong place.
 */
export class RetrievalPartNode extends WorkflowNode<RetrievalGraphRequest, RetrievalGraphData> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.part, "Resolve the authoritative catalog part.");
  }

  protected async run({ request, data }: RetrievalContext): Promise<NodeOutcome> {
    const sku = request.sku?.trim() ?? "";
    const partId = request.partId?.trim() ?? "";

    if (!sku && !partId) {
      // Bin-only identity: the bin IS the identity, resolved from what it
      // actually holds — a bin holds at most one SKU, the same invariant
      // get_bin_status already relies on, so this is never a guess.
      const requestedBinCode = request.sourceBinCode?.trim().toUpperCase() ?? "";
      const bin = await getBinByCode(requestedBinCode);
      if (!bin) {
        return {
          kind: "BLOCKED",
          reason: "source_bin_not_found",
          message: `No bin has code "${requestedBinCode}".`,
        };
      }
      const [holding] = (await getInventoryByBin(bin.code)).filter((row) => row.quantity > 0);
      if (!holding) {
        return {
          kind: "BLOCKED",
          reason: "source_bin_empty",
          message: `Bin ${bin.code} is empty; there is nothing to retrieve.`,
        };
      }
      const part = await getPartBySku(holding.sku);
      if (!part) {
        return {
          kind: "BLOCKED",
          reason: "part_not_found",
          message: `Bin ${bin.code} holds SKU "${holding.sku}", which no longer matches a catalog part.`,
        };
      }
      data.partId = part.id;
      data.sku = part.sku;
      data.canonicalName = part.canonicalName;
      return { kind: "PROCEED", summary: `${part.sku} — ${part.canonicalName}, resolved from bin ${bin.code}.` };
    }

    const part = sku ? await getPartBySku(sku) : await getPartById(partId);

    if (!part) {
      return {
        kind: "BLOCKED",
        reason: "part_not_found",
        message:
          `No catalog part matches ${sku ? `SKU "${sku}"` : `id "${partId}"`}. ` +
          "This is different from having none in stock.",
      };
    }

    data.partId = part.id;
    data.sku = part.sku;
    data.canonicalName = part.canonicalName;
    return { kind: "PROCEED", summary: `${part.sku} — ${part.canonicalName}.` };
  }
}

/* ------------------------------------------------------ 3. INVENTORY */

/** Reads authoritative stock. A known part with none is `out_of_stock`. */
export class RetrievalInventoryNode extends WorkflowNode<
  RetrievalGraphRequest,
  RetrievalGraphData
> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.inventory, "Read authoritative stock for the part.");
  }

  protected async run({ request, data }: RetrievalContext): Promise<NodeOutcome> {
    if (data.duplicate) return { kind: "PROCEED", summary: "Skipping live stock checks for an idempotent replay." };
    if (!data.sku) {
      return {
        kind: "BLOCKED",
        reason: "part_not_found",
        message: "The part was not resolved, so its stock cannot be read.",
      };
    }

    const summary = await getInventoryForPart(data.sku);
    const stockIssue = retrievalStockIssue(summary, request.sourceBinCode);
    if (stockIssue) {
      data.sourceBinCode = stockIssue.sourceBinCode;
      return { kind: "BLOCKED", reason: stockIssue.reason, message: stockIssue.message };
    }

    const stocked = summary.locations.filter(
      (location) => location.quantity > 0 && location.binStatus === "OCCUPIED",
    );
    return {
      kind: "PROCEED",
      summary: `${summary.totalQuantity} in ${stocked.map((l) => l.binCode).join(", ")}.`,
    };
  }
}

/* --------------------------------------------------------- 4. SOURCE */

/**
 * Picks which bin the item comes out of.
 *
 * An explicitly named bin is validated against what it actually holds; an
 * unnamed one uses `chooseRetrievalSourceBinCode`, the exact function the
 * retrieval service uses, so the graph can never select a bin the service
 * would not have.
 */
export class RetrievalSourceNode extends WorkflowNode<RetrievalGraphRequest, RetrievalGraphData> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.source, "Select the source bin deterministically.");
  }

  protected async run({ request, data }: RetrievalContext): Promise<NodeOutcome> {
    if (!data.sku) {
      return {
        kind: "BLOCKED",
        reason: "part_not_found",
        message: "The part was not resolved, so a source bin cannot be chosen.",
      };
    }

    if (data.duplicate) {
      const movement = await prisma.movement.findUnique({
        where: { idempotencyKey: `${RETRIEVAL_IDEMPOTENCY_PREFIX}${data.requestId}` },
        include: { sourceBin: true },
      });
      data.sourceBinCode = movement?.sourceBin?.code;
      data.sourceQuantityBefore = movement?.quantity;
      return { kind: "PROCEED", summary: "Original source restored from the completed movement." };
    }

    const summary = await getInventoryForPart(data.sku);
    const stockIssue = retrievalStockIssue(summary, request.sourceBinCode);
    if (stockIssue) {
      data.sourceBinCode = stockIssue.sourceBinCode;
      return { kind: "BLOCKED", reason: stockIssue.reason, message: stockIssue.message };
    }
    const stocked = summary.locations.filter(
      (location) => location.quantity > 0 && location.binStatus === "OCCUPIED",
    );

    let chosen: string | null;
    if (request.sourceBinCode !== undefined) {
      const requested = request.sourceBinCode.trim().toUpperCase();
      const bin = await getBinByCode(requested);
      if (!bin) {
        return {
          kind: "BLOCKED",
          reason: "source_bin_not_found",
          message: `No bin has code "${requested}".`,
        };
      }
      const holding = stocked.find((location) => location.binCode === bin.code);
      if (!holding) {
        return {
          kind: "BLOCKED",
          reason: "source_inventory_mismatch",
          message:
            `Bin ${bin.code} does not hold any ${data.sku}. It is stocked in: ` +
            `${stocked.map((l) => `${l.binCode} (${l.quantity})`).join(", ")}.`,
        };
      }
      chosen = bin.code;
    } else {
      chosen = chooseRetrievalSourceBinCode(stocked);
    }

    if (!chosen) {
      return {
        kind: "BLOCKED",
        reason: "out_of_stock",
        message: `${data.sku} is in the catalog but no bin currently holds any stock of it.`,
      };
    }
    // No separate "is this reachable" check: chosen always comes from a Bin
    // row (or a stocked location derived from one) resolved just above.

    data.sourceBinCode = chosen;
    data.sourceQuantityBefore =
      stocked.find((location) => location.binCode === chosen)?.quantity ?? 0;

    return {
      kind: "PROCEED",
      summary: `${chosen} holds ${data.sourceQuantityBefore} → ${RETRIEVAL_DESTINATION}.`,
    };
  }
}

/* ------------------------------------------------------ 5. PREFLIGHT */

/** Read-only readiness check. Advisory: the service re-checks all of it. */
export class RetrievalPreflightNode extends WorkflowNode<
  RetrievalGraphRequest,
  RetrievalGraphData
> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.preflight, "Read-only readiness check before execution.");
  }

  protected async run({ data }: RetrievalContext): Promise<NodeOutcome> {
    if (data.duplicate) {
      return { kind: "PROCEED", summary: "No gantry preflight is needed for an idempotent replay." };
    }
    const bin = data.sourceBinCode ? await getBinByCode(data.sourceBinCode) : null;
    if (!bin || !data.partId) {
      return {
        kind: "BLOCKED",
        reason: "source_bin_not_found",
        message: `No bin has code "${data.sourceBinCode}".`,
      };
    }

    if (bin.status !== "OCCUPIED") {
      return {
        kind: "BLOCKED",
        reason: "inventory_conflict",
        message: `Bin ${bin.code} is ${bin.status}, so it cannot be checked out.`,
      };
    }

    const stock = await prisma.inventory.findUnique({
      where: { partId_binId: { partId: data.partId, binId: bin.id } },
    });
    if (!stock || stock.quantity <= 0) {
      return {
        kind: "BLOCKED",
        reason: "source_inventory_mismatch",
        message: `Bin ${bin.code} no longer holds any ${data.sku}.`,
      };
    }

    // A COMPLETED movement on this key is the idempotent replay the service is
    // designed to answer, so it is not treated as a conflict here.
    const claimed = await prisma.movement.findUnique({
      where: { idempotencyKey: `${RETRIEVAL_IDEMPOTENCY_PREFIX}${data.requestId}` },
    });
    if (claimed && claimed.status !== "COMPLETED") {
      return {
        kind: "BLOCKED",
        reason: "retrieval_in_progress",
        message: "This request is already being retrieved. Wait for it to finish.",
      };
    }

    return {
      kind: "PROCEED",
      summary: `${data.sku} available in ${bin.code}.`,
    };
  }
}

/* -------------------------------------------------------- 6. EXECUTE */

/**
 * The ONLY node in this graph permitted to change warehouse state.
 *
 * It reproduces none of the Movement lifecycle, the conditional decrement, the
 * bin transition, the idempotency claim or the gantry call — `executeRetrieval`
 * owns all of it and revalidates every precondition from scratch.
 */
export class RetrievalExecuteNode extends WorkflowNode<
  RetrievalGraphRequest,
  RetrievalGraphData
> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.execute, "Ask RetrievalService to validate and execute.");
  }

  protected async run(context: RetrievalContext): Promise<NodeOutcome> {
    const { request, data } = context;
    const result: RetrievalResult = await executeRetrieval({
      verifyContents: request.verifyContents,
      sku: request.sku,
      partId: request.partId,
      sourceBinCode: request.sourceBinCode,
      // The id settled by the validate node, so the key preflight checked is
      // the key the service claims.
      requestId: data.requestId,
    });

    context.invocationState[RETRIEVAL_SERVICE_RESULT_KEY] = result;

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
        summary: `Refused by RetrievalService: ${result.reason}.`,
        ...(result.movementId ? { movementId: result.movementId } : {}),
        ...(result.gantryOperationId ? { gantryOperationId: result.gantryOperationId } : {}),
      };
    }

    data.movementId = result.movementId;
    data.gantryOperationId = result.gantryOperationId;
    data.sourceBinCode = result.sourceBinCode;
    data.partId = result.part.partId;
    data.sku = result.part.sku;

    return {
      kind: "PROCEED",
      summary: result.duplicate
        ? "Already completed for this request id; nothing was executed again."
        : `Bin ${result.sourceBinCode} moved to ${result.destination} with ` +
          `${result.checkedOutQuantity} ${result.part.sku} recorded inside.`,
    };
  }
}

/* --------------------------------------------------------- 7. VERIFY */

/**
 * Read-only coherence check. Reports, never repairs, and never retries.
 *
 * A completed checkout always carries the pre-checkout baseline
 * (data.sourceQuantityBefore) — retrieval never guesses or re-measures how
 * many units left the bin, so this should always agree with what the
 * service REPORTED (result.checkedOutQuantity).
 */
export class RetrievalVerifyNode extends WorkflowNode<RetrievalGraphRequest, RetrievalGraphData> {
  constructor() {
    super(RETRIEVAL_NODE_IDS.verify, "Confirm the committed state is coherent. Read-only.");
  }

  protected async run({ data, invocationState }: RetrievalContext): Promise<NodeOutcome> {
    const result = invocationState[RETRIEVAL_SERVICE_RESULT_KEY] as RetrievalResult | undefined;
    return verifyCommittedRetrieval(data, result);
  }
}

/** Shared read-only check, also used when orchestration expires after commit. */
export async function verifyCommittedRetrieval(
  data: RetrievalGraphData,
  result: RetrievalResult | undefined,
): Promise<NodeOutcome> {
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
      : { kind: "PROCEED", summary: "Original completed retrieval replayed; no current state was changed." };
  }

  const bin = data.sourceBinCode ? await getBinByCode(data.sourceBinCode) : null;
  if (!bin || !data.partId) {
    problems.push("the source bin is missing");
  } else {
    const stock = await prisma.inventory.findUnique({
      where: { partId_binId: { partId: data.partId, binId: bin.id } },
    });
    const remaining = stock?.quantity ?? 0;

    if (remaining < 0) {
      problems.push(`inventory in ${bin.code} is negative`);
    }
    if (result?.ok && remaining !== result.checkedOutQuantity) {
      problems.push(
        `${bin.code} records ${remaining}, but the retrieval reported ${result.checkedOutQuantity} checked out`,
      );
    }
    if (bin.status !== "CHECKED_OUT") {
      problems.push(`bin ${bin.code} is ${bin.status}, not CHECKED_OUT`);
    }
  }

  if (problems.length > 0) {
    return {
      kind: "FAILED",
      reason: "verification_failed",
      message:
        `The retrieval reported success but the warehouse state is not coherent: ${problems.join("; ")}. ` +
        "Nothing was changed to compensate; this needs manual reconciliation.",
      summary: "Committed state failed verification.",
      ...(data.movementId ? { movementId: data.movementId } : {}),
      ...(data.gantryOperationId ? { gantryOperationId: data.gantryOperationId } : {}),
    };
  }

  return {
    kind: "PROCEED",
    summary: `Movement COMPLETED; ${data.sourceBinCode} is CHECKED_OUT with its baseline count preserved.`,
  };
}
