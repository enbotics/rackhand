/**
 * Shared, side-effect-free evidence boundary for every photographed bin.
 *
 * This service owns only image interpretation and the safety facts common to
 * putaway, retrieval and inventory audit. It never moves the gantry, changes
 * inventory, chooses a workflow outcome or asks for human approval. Each
 * caller remains responsible for applying its own expected/observed quantity
 * policy after these common gates pass.
 */
import { inspectBinImageWithGemini } from "@/lib/geminiAuditCount";

export interface BinInspectionContext {
  binCode: string;
  sku: string | null;
  canonicalName: string | null;
  dimensions: {
    lengthMM: number | null;
    widthMM: number | null;
    heightMM: number | null;
  } | null;
}

export interface BinInspectionEvidence {
  countable: boolean;
  observedCount: number | null;
  countConfidence: number;
  expectedPartPresent: boolean;
  foreignObjectSuspected: boolean;
  foreignObjects?: string[];
  occlusion: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  notes: string;
}

export type BinInspectionSafetyGate =
  | "CLEAR"
  | "FOREIGN_OBJECTS"
  | "LOW_CONFIDENCE"
  | "CAPACITY_EXCEEDED";

export type BinInspectionAssessment =
  | {
      gate: "CLEAR";
      observedQuantity: number;
      foreignObjects: string[];
    }
  | {
      gate: Exclude<BinInspectionSafetyGate, "CLEAR">;
      observedQuantity: number | null;
      foreignObjects: string[];
    };

/** One shared Gemini/Strands observation path for every bin workflow. */
export function inspectBinImage(
  imageBuffer: Buffer,
  context: BinInspectionContext,
): Promise<BinInspectionEvidence> {
  return inspectBinImageWithGemini(imageBuffer, context);
}

/**
 * Apply only the safety gates shared by all photographed-bin workflows.
 * The strict `>` threshold deliberately preserves the existing 80% policy:
 * exactly 80% is not sufficient for an automatic decision.
 */
export function assessBinInspection(
  evidence: BinInspectionEvidence,
  options: {
    confidenceThreshold: number;
    capacity: number;
    requireExpectedPart: boolean;
  },
): BinInspectionAssessment {
  const foreignObjects = evidence.foreignObjects ?? [];
  if (evidence.foreignObjectSuspected || foreignObjects.length > 0) {
    return {
      gate: "FOREIGN_OBJECTS",
      observedQuantity: evidence.observedCount,
      foreignObjects,
    };
  }

  const observedQuantity = evidence.observedCount;
  const reliable =
    evidence.countable &&
    observedQuantity !== null &&
    evidence.countConfidence > options.confidenceThreshold &&
    (evidence.occlusion === "NONE" || evidence.occlusion === "LOW") &&
    (!options.requireExpectedPart ||
      observedQuantity === 0 ||
      evidence.expectedPartPresent);

  if (!reliable) {
    return { gate: "LOW_CONFIDENCE", observedQuantity, foreignObjects };
  }
  if (observedQuantity > options.capacity) {
    return {
      gate: "CAPACITY_EXCEEDED",
      observedQuantity,
      foreignObjects,
    };
  }
  return { gate: "CLEAR", observedQuantity, foreignObjects };
}

/** Safe decoding for the object names persisted with an inspection. */
export function parseInspectionForeignObjects(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}
