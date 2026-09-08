import { NextResponse } from "next/server";
import { parseJsonBody, warehouseErrorResponse } from "@/lib/warehouse/http";
import { collectScanResultIssues } from "@/lib/warehouse/scan-result";
import { prepareGuidedPutaway } from "@/lib/warehouse/guided-putaway-service";
import { WarehouseError } from "@/lib/warehouse/errors";
import type { ScanResult } from "@/lib/warehouse/scan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate the scan and atomically reserve the selected available slot. */
export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const issues = collectScanResultIssues(body.scanResult);
    if (issues.length > 0) {
      throw new WarehouseError("validation_failed", "Invalid scanResult.", issues);
    }
    if (typeof body.destinationBinCode !== "string") {
      throw new WarehouseError("validation_failed", "A destination bin is required.");
    }
    if (
      body.catalogResolutionId !== undefined &&
      typeof body.catalogResolutionId !== "string"
    ) {
      throw new WarehouseError("validation_failed", "Invalid catalogResolutionId.");
    }
    if (body.imageDataUrl !== undefined && typeof body.imageDataUrl !== "string") {
      throw new WarehouseError("validation_failed", "Invalid imageDataUrl.");
    }

    return NextResponse.json(
      await prepareGuidedPutaway({
        scanResult: body.scanResult as ScanResult,
        destinationBinCode: body.destinationBinCode,
        ...(typeof body.catalogResolutionId === "string"
          ? { catalogResolutionId: body.catalogResolutionId }
          : {}),
        ...(typeof body.imageDataUrl === "string" ? { imageDataUrl: body.imageDataUrl } : {}),
      }),
    );
  } catch (error) {
    return warehouseErrorResponse(error);
  }
}
