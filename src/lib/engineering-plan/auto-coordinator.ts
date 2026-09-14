import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/warehouse/db";
import { warehouseIdleReason } from "./idle-service";
import { engineeringPlanFingerprint } from "./sheet-events";
import { getEngineeringPlanContextForWorkDate, tomorrowEngineeringPlanWorkDate } from "./google-sheets";
import { executeTodayPlanAnalysis, recoverAbandonedTodayPlanAnalysis } from "./analysis-service";

const DEBOUNCE_MS = 15_000;
export const AUTOMATIC_PLAN_OWNER = "rackhand:sheet-events";
export function automaticPlansEnabled() { return process.env.ENGINEERING_PLAN_AUTO_ENABLED === "true"; }

export async function recordEngineeringPlanChange(spreadsheetId: string, occurredAt: number) {
  const signalAt = new Date(occurredAt);
  const data = { signalAt, dueAt: new Date(Date.now() + DEBOUNCE_MS), pending: true, lastError: null };
  await prisma.engineeringPlanInbox.upsert({
    where: { id: spreadsheetId }, create: { id: spreadsheetId, ...data }, update: {},
  });
  // Replayed/delayed older signatures cannot extend the debounce or overwrite a new signal.
  await prisma.engineeringPlanInbox.updateMany({
    where: { id: spreadsheetId, signalAt: { lt: signalAt } }, data,
  });
}

async function readPendingSheetChange() {
  const id = process.env.ENGINEERING_PLAN_SPREADSHEET_ID?.trim();
  if (!id) return;
  const token = randomUUID();
  const claimed = await prisma.engineeringPlanInbox.updateMany({
    where: { id, pending: true, dueAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
    data: { leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) },
  });
  if (!claimed.count) return;
  try {
    const inbox = await prisma.engineeringPlanInbox.findUniqueOrThrow({ where: { id } });
    const workDate = tomorrowEngineeringPlanWorkDate();
    const context = await getEngineeringPlanContextForWorkDate(workDate);
    if (!context.configured || context.reason === "unavailable" || context.reason === "not_configured")
      throw new Error("Tomorrow’s Sheet could not be read. The change remains queued.");
    const fingerprint = engineeringPlanFingerprint(context);
    await prisma.$transaction(async (tx) => {
      // Locks the inbox row and proves no newer edit arrived while we read Sheets.
      const settled = await tx.engineeringPlanInbox.updateMany({
        where: { id, leaseToken: token, signalAt: inbox.signalAt, leaseUntil: { gt: new Date() } },
        data: { pending: false, lastFingerprint: fingerprint, lastWorkDate: workDate, lastError: null },
      });
      if (!settled.count || (inbox.lastFingerprint === fingerprint && inbox.lastWorkDate === workDate)) return;
      await tx.engineeringPlanAnalysisRun.updateMany({
        where: { trigger: "SHEET_CHANGE", status: "QUEUED", activeKey: null },
        data: { status: "SUPERSEDED", stage: "COMPLETE", completedAt: new Date() },
      });
      await tx.engineeringPlanAnalysisRun.create({
        data: {
          ownerSessionId: AUTOMATIC_PLAN_OWNER, trigger: "SHEET_CHANGE", status: "QUEUED",
          stage: "WAITING_FOR_IDLE", workDate, sourceFingerprint: fingerprint,
          sourceContextJson: JSON.stringify(context), rowsFound: context.rows.length,
          planRowsJson: JSON.stringify(context.rows.map(({ planId, project, buildTask, priority, status }) =>
            ({ planId, project, buildTask, priority, status }))),
          events: { create: { sequence: 1, stage: "WAITING_FOR_IDLE", status: "QUEUED",
            summary: `Tomorrow’s plan (${workDate}) has changed. I’ve queued the latest version and will analyze it when the warehouse is free.` } },
        },
      });
    });
  } catch (error) {
    console.error("[automatic-plan] Sheet update remains pending:", error);
    await prisma.engineeringPlanInbox.updateMany({
      where: { id, leaseToken: token }, data: {
        dueAt: new Date(Date.now() + 60_000),
        lastError: "I couldn’t read tomorrow’s Sheet plan. The update is safely queued; I’ll retry the connection shortly.",
      },
    });
  } finally {
    await prisma.engineeringPlanInbox.updateMany({
      where: { id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null },
    });
  }
}

export async function coordinateAutomaticPlans(): Promise<void> {
  if (!automaticPlansEnabled()) return;
  await readPendingSheetChange();
  await recoverAbandonedTodayPlanAnalysis();
  if (await prisma.engineeringPlanInbox.findFirst({ where: { pending: true } })) return;
  // New dates/versions replace obsolete waiting work; never touch an active cycle.
  const workDate = tomorrowEngineeringPlanWorkDate();
  await prisma.engineeringPlanAnalysisRun.updateMany({
    where: { trigger: "SHEET_CHANGE", status: "QUEUED", activeKey: null, workDate: { not: workDate } },
    data: { status: "SUPERSEDED", stage: "COMPLETE", completedAt: new Date() },
  });
  const run = await prisma.engineeringPlanAnalysisRun.findFirst({
    where: { trigger: "SHEET_CHANGE", status: "QUEUED", workDate }, orderBy: { createdAt: "desc" },
  });
  if (!run) return;
  const active = await prisma.engineeringPlanAnalysisRun.findFirst({ where: { activeKey: "ACTIVE" } });
  if (active) return;
  // An older paused run may have yielded to a newer update while it was running.
  await prisma.engineeringPlanAnalysisRun.updateMany({
    where: { trigger: "SHEET_CHANGE", status: "QUEUED", activeKey: null, createdAt: { lt: run.createdAt } },
    data: { status: "SUPERSEDED", stage: "COMPLETE", completedAt: new Date() },
  });
  const reason = await warehouseIdleReason(Boolean(run.startedAt));
  if (reason) {
    const latest = await prisma.engineeringPlanAnalysisEvent.findFirst({
      where: { runId: run.id }, orderBy: { sequence: "desc" },
    });
    if (latest?.summary !== reason) {
      await prisma.engineeringPlanAnalysisEvent.create({ data: {
        runId: run.id, sequence: (latest?.sequence ?? 0) + 1,
        stage: "WAITING_FOR_IDLE", status: "QUEUED", summary: reason,
      } }).catch((error) => {
        if ((error as { code?: string })?.code !== "P2002") throw error;
      });
    }
    return;
  }
  await executeTodayPlanAnalysis(run.id);
}

/** EC2/PM2 Node server: drains persisted events even when no browser is open.
 * This does NOT periodically scan Sheets. Only signed changes cause a Sheet read.
 */
export function startAutomaticPlanCoordinator() {
  if (!automaticPlansEnabled()) return;
  const shared = globalThis as typeof globalThis & { automaticPlanTimer?: ReturnType<typeof setInterval> };
  if (shared.automaticPlanTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await coordinateAutomaticPlans(); }
    catch (error) { console.error("[automatic-plan] coordinator failed:", error); }
    finally { running = false; }
  };
  shared.automaticPlanTimer = setInterval(() => { void tick(); }, 10_000);
  shared.automaticPlanTimer.unref();
  void tick();
}
