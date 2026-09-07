import type { BinStatus } from "./types";

export interface PutawayDestinationState {
  code: string;
  status: BinStatus;
  capacity: number;
  contents: Array<{ partId: string; quantity: number }>;
}

export interface PutawayDestinationEvaluation {
  eligible: boolean;
  currentQuantity: number;
  afterQuantity: number;
  remainingAfter: number;
  alreadyStoresPart: boolean;
  reason: "COMPATIBLE" | "FULL" | "RESERVED" | "DISABLED" | "DIFFERENT_PART" | "INCONSISTENT";
}

/**
 * One shared compatibility rule for the slot picker and server reservation:
 * empty AVAILABLE bins work, and OCCUPIED bins work only for the same part
 * while the additional quantity remains within capacity.
 */
export function evaluatePutawayDestination(
  bin: PutawayDestinationState,
  partId: string,
  quantity = 1,
): PutawayDestinationEvaluation {
  const currentQuantity = bin.contents.reduce((sum, item) => sum + item.quantity, 0);
  const afterQuantity = currentQuantity + quantity;
  const remainingAfter = Math.max(0, bin.capacity - afterQuantity);
  const alreadyStoresPart =
    bin.contents.length > 0 && bin.contents.every((item) => item.partId === partId);

  const base = { currentQuantity, afterQuantity, remainingAfter, alreadyStoresPart };
  if (bin.status === "DISABLED") return { ...base, eligible: false, reason: "DISABLED" };
  if (bin.status === "RESERVED") return { ...base, eligible: false, reason: "RESERVED" };
  if (bin.contents.some((item) => item.partId !== partId)) {
    return { ...base, eligible: false, reason: "DIFFERENT_PART" };
  }
  if (
    (bin.status === "AVAILABLE" && currentQuantity !== 0) ||
    (bin.status === "OCCUPIED" && currentQuantity === 0)
  ) {
    return { ...base, eligible: false, reason: "INCONSISTENT" };
  }
  if (afterQuantity > bin.capacity) return { ...base, eligible: false, reason: "FULL" };
  return { ...base, eligible: true, reason: "COMPATIBLE" };
}
