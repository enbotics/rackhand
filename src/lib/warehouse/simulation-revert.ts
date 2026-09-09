/**
 * Undoes an inventory write a SIMULATED capture caused, a few seconds after
 * it happened.
 *
 * Simulation photos are sampled from a curated demo pool, never the real
 * physical bin — so a quantity change they cause is not a real observation
 * and must never persist as one. The write still happens immediately and
 * for real (an operator watching genuinely sees the number change), and
 * that visible bump-then-revert cycle IS the "this was a simulation" signal
 * — deliberately not instant and not silent, so nobody mistakes a five-
 * second demo blip for a real stock change that quietly vanished.
 *
 * PROCESS-LOCAL, same as every other simulation/demo mechanism in this
 * codebase (gantry singleton, conversation store): a bare setTimeout, not a
 * durable job. Losing it on a restart just means a demo write is never
 * undone, which only matters for demo data in the first place.
 */
import { prisma } from "./db";

export const SIMULATION_REVERT_DELAY_MS = 5_000;

export function scheduleSimulationRevert(input: {
  partId: string;
  binId: string;
  previousQuantity: number;
  /** "audit" or "putaway", purely for the log line. */
  source: string;
}): void {
  setTimeout(() => {
    void (async () => {
      try {
        // A bin that moved on to something else (checked out, disabled,
        // deleted) since the simulated write is left alone rather than
        // reverted into a state it can no longer make sense of.
        const bin = await prisma.bin.findUnique({ where: { id: input.binId } });
        if (!bin || (bin.status !== "AVAILABLE" && bin.status !== "OCCUPIED")) return;

        await prisma.$transaction(async (tx) => {
          const existing = await tx.inventory.findUnique({
            where: { partId_binId: { partId: input.partId, binId: input.binId } },
          });
          if (input.previousQuantity <= 0) {
            if (existing) await tx.inventory.delete({ where: { id: existing.id } });
          } else if (existing) {
            await tx.inventory.update({ where: { id: existing.id }, data: { quantity: input.previousQuantity } });
          } else {
            await tx.inventory.create({ data: { partId: input.partId, binId: input.binId, quantity: input.previousQuantity } });
          }
          await tx.bin.update({
            where: { id: input.binId },
            data: { status: input.previousQuantity > 0 ? "OCCUPIED" : "AVAILABLE" },
          });
        });
        console.log(
          `[simulation] reverted ${input.source} quantity change on bin ${input.binId} back to ${input.previousQuantity} — demo capture, not a real count`,
        );
      } catch (error) {
        console.error(`[simulation] revert failed for bin ${input.binId}`, error);
      }
    })();
  }, SIMULATION_REVERT_DELAY_MS);
}
