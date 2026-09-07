import { parseBinCode } from "./types";

/**
 * The operator-facing order of the physical rack: highest bed at the top,
 * then slots from left to right. Database ordering is intentionally ignored.
 */
export function compareBinsInShelfOrder(a: { code: string }, b: { code: string }): number {
  const left = parseBinCode(a.code);
  const right = parseBinCode(b.code);

  if (left && right) {
    if (left.bed !== right.bed) return right.bed - left.bed;
    if (left.slot !== right.slot) return left.slot - right.slot;
  } else if (left) {
    return -1;
  } else if (right) {
    return 1;
  }

  return a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" });
}

export function groupBinsInShelfOrder<T extends { code: string }>(
  bins: readonly T[],
): Array<{ bed: number | null; bins: T[] }> {
  const rows = new Map<number | null, T[]>();

  for (const bin of [...bins].sort(compareBinsInShelfOrder)) {
    const bed = parseBinCode(bin.code)?.bed ?? null;
    rows.set(bed, [...(rows.get(bed) ?? []), bin]);
  }

  return [...rows.entries()].map(([bed, rowBins]) => ({ bed, bins: rowBins }));
}
