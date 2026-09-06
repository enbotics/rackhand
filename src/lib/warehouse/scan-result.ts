/**
 * Creation, validation and conversion helpers for the warehouse ScanResult
 * contract (see scan-types.ts).
 *
 * `measurementToScanResult` is the single place the existing measurement
 * pipeline's output becomes a warehouse scan. It is deterministic apart from
 * the generated `scanId`, and that randomness is isolated in `createScanId`
 * (pass `capture.scanId` to remove it entirely).
 *
 * Validation rejects rather than silently repairs: a measurement with a
 * non-finite, zero or out-of-range value produces `ok: false` with the list
 * of offending fields, so a malformed value can never reach downstream
 * consumers wearing a valid ScanResult's type. No validation library — the
 * contract is eight fields with fixed rules.
 */
import type {
  MeasurementResult,
  ScanCaptureMeta,
  ScanConversion,
  ScanResult,
} from "./scan-types";

/** Runtime guard, not just a type check — an API body or an old IndexedDB record can carry anything. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `scan_<capturedAt>_<random>` — unique per scan, deliberately not derived from the object. */
export function createScanId(capturedAt: number): string {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `scan_${capturedAt}_${suffix}`;
}

/**
 * Converts one measured shot into a warehouse ScanResult.
 *
 * `measurement` is the `/api/measure` response body (or the measured half of
 * a persisted `Measurement`); `capture` supplies the capture-side metadata
 * measurement does not carry. Returns every validation issue at once.
 */
export function measurementToScanResult(
  measurement: MeasurementResult,
  capture: ScanCaptureMeta,
): ScanConversion {
  const issues: string[] = [];

  const capturedAt = finiteNumber(capture?.capturedAt);
  if (capturedAt === null || capturedAt <= 0) {
    issues.push("capturedAt must be a finite epoch timestamp greater than 0");
  }

  const detectedName = trimmedString(measurement?.name);
  if (!detectedName) {
    issues.push("object.detectedName must be a non-empty string");
  }

  const lengthMM = finiteNumber(measurement?.lengthMM);
  if (lengthMM === null || lengthMM <= 0) {
    issues.push("dimensions.lengthMM must be a finite number greater than 0");
  }

  const widthMM = finiteNumber(measurement?.widthMM);
  if (widthMM === null || widthMM <= 0) {
    issues.push("dimensions.widthMM must be a finite number greater than 0");
  }

  // Absent height is a legitimate answer from a single overhead frame, so
  // null/undefined maps to null — but a present height still has to be real.
  let heightMM: number | null = null;
  if (measurement?.heightMM != null) {
    const height = finiteNumber(measurement.heightMM);
    if (height === null || height <= 0) {
      issues.push("dimensions.heightMM must be null or a finite number greater than 0");
    } else {
      heightMM = height;
    }
  }

  const dimensionConfidence = finiteNumber(measurement?.dimensionConfidence);
  if (dimensionConfidence === null || dimensionConfidence < 0 || dimensionConfidence > 1) {
    issues.push("quality.dimensionConfidence must be a finite number between 0 and 1");
  }

  const calibrationRmsPixels = finiteNumber(measurement?.calibrationRmsPixels);
  if (calibrationRmsPixels === null || calibrationRmsPixels < 0) {
    issues.push("quality.calibrationRmsPixels must be a finite number of 0 or more");
  }

  const angleDegrees = finiteNumber(measurement?.angleDegrees);
  if (angleDegrees === null) {
    issues.push("orientation.angleDegrees must be a finite number");
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    scanResult: {
      scanId: trimmedString(capture.scanId) || createScanId(capturedAt!),
      capturedAt: capturedAt!,
      object: {
        detectedName,
        description: trimmedString(measurement.description),
      },
      dimensions: {
        lengthMM: lengthMM!,
        widthMM: widthMM!,
        heightMM,
      },
      quality: {
        dimensionConfidence: dimensionConfidence!,
        calibrationRmsPixels: calibrationRmsPixels!,
      },
      orientation: {
        angleDegrees: angleDegrees!,
      },
    },
  };
}

/**
 * Every way `value` fails the ScanResult contract, as field-level issues.
 *
 * This is the single definition of those rules — `isScanResult` is simply
 * "no issues" — so the IndexedDB read path and the catalog-match API agree on
 * what a valid scan is, while the API can still report *which* field was
 * malformed instead of only that something was. Same numeric rules as
 * `measurementToScanResult`, so nothing accepted here is something the
 * conversion would have rejected.
 */
export function collectScanResultIssues(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["scanResult must be an object"];
  }
  const scan = value as Record<string, unknown>;
  const issues: string[] = [];

  if (!trimmedString(scan.scanId)) issues.push("scanId must be a non-empty string");

  const capturedAt = finiteNumber(scan.capturedAt);
  if (capturedAt === null || capturedAt <= 0) {
    issues.push("capturedAt must be a finite epoch timestamp greater than 0");
  }

  const object = scan.object as Record<string, unknown> | undefined;
  if (typeof object !== "object" || object === null) {
    issues.push("object must be an object");
  } else {
    if (!trimmedString(object.detectedName)) {
      issues.push("object.detectedName must be a non-empty string");
    }
    if (typeof object.description !== "string") {
      issues.push("object.description must be a string");
    }
  }

  const dimensions = scan.dimensions as Record<string, unknown> | undefined;
  if (typeof dimensions !== "object" || dimensions === null) {
    issues.push("dimensions must be an object");
  } else {
    const lengthMM = finiteNumber(dimensions.lengthMM);
    if (lengthMM === null || lengthMM <= 0) {
      issues.push("dimensions.lengthMM must be a finite number greater than 0");
    }
    const widthMM = finiteNumber(dimensions.widthMM);
    if (widthMM === null || widthMM <= 0) {
      issues.push("dimensions.widthMM must be a finite number greater than 0");
    }
    if (dimensions.heightMM !== null) {
      const heightMM = finiteNumber(dimensions.heightMM);
      if (heightMM === null || heightMM <= 0) {
        issues.push("dimensions.heightMM must be null or a finite number greater than 0");
      }
    }
  }

  const quality = scan.quality as Record<string, unknown> | undefined;
  if (typeof quality !== "object" || quality === null) {
    issues.push("quality must be an object");
  } else {
    const dimensionConfidence = finiteNumber(quality.dimensionConfidence);
    if (dimensionConfidence === null || dimensionConfidence < 0 || dimensionConfidence > 1) {
      issues.push("quality.dimensionConfidence must be a finite number between 0 and 1");
    }
    const calibrationRmsPixels = finiteNumber(quality.calibrationRmsPixels);
    if (calibrationRmsPixels === null || calibrationRmsPixels < 0) {
      issues.push("quality.calibrationRmsPixels must be a finite number of 0 or more");
    }
  }

  const orientation = scan.orientation as Record<string, unknown> | undefined;
  if (typeof orientation !== "object" || orientation === null) {
    issues.push("orientation must be an object");
  } else if (finiteNumber(orientation.angleDegrees) === null) {
    issues.push("orientation.angleDegrees must be a finite number");
  }

  return issues;
}

/**
 * Structural check for a value that claims to be a ScanResult — used when
 * reading records back out of IndexedDB, where a shot may predate this
 * contract or have been written by an older build.
 */
export function isScanResult(value: unknown): value is ScanResult {
  return collectScanResultIssues(value).length === 0;
}
