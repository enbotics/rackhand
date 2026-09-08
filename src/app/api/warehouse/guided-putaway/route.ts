import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Guided putaway was replaced by the orchestrator-owned physical workflow. */
export async function POST() {
  return NextResponse.json(
    {
      error: {
        code: "guided_putaway_removed",
        message: "Use the Warehouse Agent putaway approval flow.",
      },
    },
    { status: 410 },
  );
}
