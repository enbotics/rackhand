import { describe, expect, it } from "vitest";
import { assessBinInspection } from "@/lib/warehouse/bin-inspection-service";
import { PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD } from "@/lib/warehouse/putaway-capture-types";

const clearEvidence = {
  countable: true,
  observedCount: 27,
  countConfidence: 0.61,
  expectedPartPresent: true,
  foreignObjectSuspected: false,
  foreignObjects: [] as string[],
  occlusion: "NONE" as const,
  notes: "Twenty-seven expected parts are visible.",
};

function assess(countConfidence: number) {
  return assessBinInspection(
    { ...clearEvidence, countConfidence },
    {
      confidenceThreshold: PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
      capacity: 40,
      requireExpectedPart: true,
    },
  );
}

describe("putaway confidence policy", () => {
  it("allows a clear observation above 60% confidence to continue", () => {
    expect(PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(assess(0.61).gate).toBe("CLEAR");
    expect(assess(0.8).gate).toBe("CLEAR");
  });

  it("still requires review at exactly 60% or below", () => {
    expect(assess(0.6).gate).toBe("LOW_CONFIDENCE");
    expect(assess(0.59).gate).toBe("LOW_CONFIDENCE");
  });

  it("does not bypass the foreign-object safety check", () => {
    const result = assessBinInspection(
      {
        ...clearEvidence,
        countConfidence: 0.8,
        foreignObjectSuspected: true,
        foreignObjects: ["unknown metal piece"],
      },
      {
        confidenceThreshold: PUTAWAY_CAPTURE_CONFIDENCE_THRESHOLD,
        capacity: 40,
        requireExpectedPart: true,
      },
    );

    expect(result.gate).toBe("FOREIGN_OBJECTS");
  });
});
