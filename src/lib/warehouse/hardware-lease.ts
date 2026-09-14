import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { GantryError } from "@/lib/gantry/errors";

const RESOURCE = "WAREHOUSE_GANTRY";
const LEASE_MS = 90_000;
// Independently bundled routes must share the reentrant context as well.
const shared = globalThis as typeof globalThis & {
  warehouseHardwareContext?: AsyncLocalStorage<string>;
};
const context = shared.warehouseHardwareContext ??= new AsyncLocalStorage<string>();

/** Never revoke a live lease. A crashed holder is recoverable after heartbeat loss. */
export async function withWarehouseHardwareLease<T>(work: () => Promise<T>, waitMs = 0): Promise<T> {
  const inherited = context.getStore();
  if (inherited) {
    const renewed = await prisma.warehouseHardwareLease.updateMany({
      where: { id: RESOURCE, token: inherited, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date(Date.now() + LEASE_MS) },
    });
    if (renewed.count !== 1) throw new GantryError("gantry_busy", "The hardware lease was lost. No new movement was started.");
    return work();
  }
  const token = randomUUID();
  let acquired = false;
  const deadline = Date.now() + waitMs;
  do {
    const expiresAt = new Date(Date.now() + LEASE_MS);
    try {
      await prisma.warehouseHardwareLease.create({ data: { id: RESOURCE, token, expiresAt } });
      acquired = true;
    } catch (error) {
      if ((error as { code?: string })?.code !== "P2002") throw error;
      const claimed = await prisma.warehouseHardwareLease.updateMany({
        where: { id: RESOURCE, expiresAt: { lte: new Date() } }, data: { token, expiresAt },
      });
      acquired = claimed.count === 1;
    }
    if (!acquired && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  } while (!acquired && Date.now() < deadline);
  if (!acquired) throw new GantryError("gantry_busy", "The shared gantry is finishing another operation. Please retry when it is free.");
  const timer = setInterval(() => {
    void prisma.warehouseHardwareLease.updateMany({
      where: { id: RESOURCE, token }, data: { expiresAt: new Date(Date.now() + LEASE_MS) },
    }).catch((error) => console.error("[hardware-lease] heartbeat failed", error));
  }, 15_000);
  timer.unref();
  try {
    return await context.run(token, work);
  } finally {
    clearInterval(timer);
    await prisma.warehouseHardwareLease.deleteMany({ where: { id: RESOURCE, token } })
      .catch((error) => console.error("[hardware-lease] release failed; heartbeat expiry will recover it", error));
  }
}

export async function withWarehouseClientActivity<T>(work: () => Promise<T>): Promise<T> {
  const id = randomUUID();
  await prisma.warehouseClientActivity.create({ data: { id, expiresAt: new Date(Date.now() + LEASE_MS) } });
  const timer = setInterval(() => {
    void prisma.warehouseClientActivity.updateMany({
      where: { id }, data: { expiresAt: new Date(Date.now() + LEASE_MS) },
    }).catch(console.error);
  }, 15_000);
  timer.unref();
  try { return await work(); }
  finally {
    clearInterval(timer);
    await prisma.warehouseClientActivity.deleteMany({ where: { id } }).catch(console.error);
  }
}
