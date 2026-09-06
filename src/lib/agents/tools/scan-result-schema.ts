/**
 * A Zod view of the Milestone 1 ScanResult, for Strands tool schemas.
 *
 * NOT a second contract. The shape below exists so the SDK can publish a JSON
 * schema, but the *rules* stay in `collectScanResultIssues` — the same
 * validator /api/measure and the catalog matcher already use — reached here
 * through `superRefine`. Adding a rule there applies it everywhere; there is
 * no second place to keep in step.
 */
import { z } from "zod";
import { collectScanResultIssues } from "@/lib/warehouse/scan-result";

export const scanResultSchema = z
  .object({
    scanId: z.string(),
    capturedAt: z.number(),
    object: z.object({
      detectedName: z.string(),
      description: z.string(),
    }),
    dimensions: z.object({
      lengthMM: z.number(),
      widthMM: z.number(),
      heightMM: z.number().nullable(),
    }),
    quality: z.object({
      dimensionConfidence: z.number(),
      calibrationRmsPixels: z.number(),
    }),
    orientation: z.object({
      angleDegrees: z.number(),
    }),
  })
  .superRefine((value, ctx) => {
    // The authoritative rule set — ranges, finiteness, ordering.
    for (const message of collectScanResultIssues(value)) {
      ctx.addIssue({ code: "custom", message });
    }
  });
