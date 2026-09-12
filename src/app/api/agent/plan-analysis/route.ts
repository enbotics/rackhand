import { after, NextResponse } from "next/server";
import {
  createTodayPlanAnalysisRun,
  executeTodayPlanAnalysis,
  getActiveTodayPlanAnalysis,
  getLatestTodayPlanAnalysis,
  TodayPlanAnalysisBusyError,
} from "@/lib/engineering-plan/analysis-service";
import { warehouseSessionIdFromRequest } from "@/lib/warehouse/workflow-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sessionRequired() {
  return NextResponse.json(
    { error: { code: "warehouse_session_required", message: "A valid warehouse session is required." } },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return sessionRequired();
  return NextResponse.json({ run: await getLatestTodayPlanAnalysis(sessionId) });
}

export async function POST(request: Request) {
  const sessionId = warehouseSessionIdFromRequest(request);
  if (!sessionId) return sessionRequired();
  try {
    const created = await createTodayPlanAnalysisRun(sessionId);
    after(() => executeTodayPlanAnalysis(created.id));
    return NextResponse.json(
      { run: await getLatestTodayPlanAnalysis(sessionId), started: true },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof TodayPlanAnalysisBusyError) {
      const ownRun = await getActiveTodayPlanAnalysis(sessionId);
      if (ownRun) {
        return NextResponse.json({ run: ownRun, started: false }, { status: 202 });
      }
      return NextResponse.json(
        {
          error: {
            code: "today_plan_analysis_busy",
            message: "RackHand is already using the shared gantry for another plan analysis.",
          },
        },
        { status: 409 },
      );
    }
    console.error("[agent/plan-analysis] trigger failed:", error);
    return NextResponse.json(
      {
        error: {
          code: "today_plan_analysis_failed",
          message: "RackHand could not start today's plan analysis.",
        },
      },
      { status: 500 },
    );
  }
}
