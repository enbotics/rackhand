import { NextResponse } from "next/server";
import { getGantryController } from "@/lib/gantry/factory";
import { gantryErrorResponse } from "@/lib/gantry/http";

/** GET /api/gantry/status — current machine state. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getGantryController().getStatus());
  } catch (err) {
    return gantryErrorResponse(err);
  }
}
