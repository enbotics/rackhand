import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Client physical writes must cross the Warehouse Agent's HITL boundary. */
export async function POST() {
  return NextResponse.json(
    {
      error: {
        code: "client_physical_action_requires_approval",
        message: "Use /api/agent for putaway so a human can approve the physical action.",
      },
    },
    { status: 403 },
  );
}
