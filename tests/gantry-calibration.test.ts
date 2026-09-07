import { describe, expect, it } from "vitest";
import {
  BIN_CORRECTIONS,
  CALIBRATED,
  GANTRY_CALIBRATION,
  PICKUP_MARK,
  RETRACTED_YMM,
  SAFE_TRAVEL_ZMM,
  SHELF_GRID,
  STATION_POSITIONS,
  resolveBinPosition,
  resolvePosition,
} from "@/lib/gantry/calibration";
import { SEED_BIN_CODES, SLOTS_PER_BED, STORAGE_BEDS, parseBinCode } from "@/lib/warehouse/types";

/**
 * The calibration is placeholder data, so there is nothing here about whether
 * a number is RIGHT — only that the arithmetic is sound and, above all, that
 * a location which is not a real slot resolves to nothing.
 *
 * That last one is the whole point. A wrong coordinate drives a machine into a
 * shelf, and the way that happens is not a bad measurement but a bogus code
 * quietly turning into a plausible-looking position.
 */

describe("the calibration is honestly marked", () => {
  it("declares itself uncalibrated until the rack is measured", () => {
    expect(CALIBRATED).toBe(false);
    expect(GANTRY_CALIBRATION.calibrated).toBe(false);
  });

  it("is in millimetres and matches the shelf the warehouse believes in", () => {
    expect(GANTRY_CALIBRATION.units).toBe("mm");
    expect(GANTRY_CALIBRATION.beds).toBe(STORAGE_BEDS);
    expect(GANTRY_CALIBRATION.slotsPerBed).toBe(SLOTS_PER_BED);
  });

  it("starts with no per-bin corrections", () => {
    // Corrections record where reality DISAGREES with the grid. Any entry here
    // before the rack has been measured would be fiction.
    expect(Object.keys(BIN_CORRECTIONS)).toHaveLength(0);
  });
});

describe("resolving a bin", () => {
  it("gives every seeded bin exactly one position", () => {
    for (const code of SEED_BIN_CODES) {
      const position = resolveBinPosition(code);
      expect(position, `${code} has no position`).not.toBeNull();
      expect(Number.isFinite(position!.xMM)).toBe(true);
      expect(Number.isFinite(position!.yMM)).toBe(true);
      expect(Number.isFinite(position!.zMM)).toBe(true);
    }
  });

  it("gives every bin a DISTINCT position", () => {
    // Two bins sharing a position means the machine cannot tell them apart.
    const seen = new Set(
      SEED_BIN_CODES.map((code) => {
        const p = resolveBinPosition(code)!;
        return `${p.xMM},${p.yMM},${p.zMM}`;
      }),
    );
    expect(seen.size).toBe(SEED_BIN_CODES.length);
  });

  it("steps along X by the slot pitch and up Z by the bed pitch", () => {
    const a = resolveBinPosition("B1-01")!;
    const nextSlot = resolveBinPosition("B1-02")!;
    const nextBed = resolveBinPosition("B2-01")!;

    expect(nextSlot.xMM - a.xMM).toBe(SHELF_GRID.slotPitchMM);
    expect(nextSlot.zMM).toBe(a.zMM);

    expect(nextBed.zMM - a.zMM).toBe(SHELF_GRID.bedPitchMM);
    expect(nextBed.xMM).toBe(a.xMM);
  });

  it("puts bed 1 lowest and bed 6 highest", () => {
    const bottom = resolveBinPosition("B1-01")!;
    const top = resolveBinPosition("B6-01")!;
    expect(top.zMM).toBeGreaterThan(bottom.zMM);
  });

  it("reaches into the shelf by the approach depth", () => {
    expect(resolveBinPosition("B3-03")!.yMM).toBe(
      SHELF_GRID.origin.yMM + SHELF_GRID.approachDepthMM,
    );
  });
});

describe("a location that is not a real slot resolves to nothing", () => {
  // Regression: parseBinCode once checked only the LOWER bounds, so "B9-99"
  // parsed as bed 9 slot 99 and derived a position outside the rack.
  it.each(["B9-99", "B7-01", "B1-06", "B0-01", "B1-00"])("%s is not a bin", (code) => {
    expect(parseBinCode(code)).toBeNull();
    expect(resolveBinPosition(code)).toBeNull();
  });

  it("rejects the retired code scheme and plain nonsense", () => {
    for (const code of ["A01", "B03", "", "   ", "B1-1", "B1-001", "nonsense"]) {
      expect(resolveBinPosition(code)).toBeNull();
    }
  });
});

describe("the scan station", () => {
  it("has a position for both directions of travel", () => {
    expect(resolvePosition("INTAKE")).toEqual(STATION_POSITIONS.INTAKE);
    expect(resolvePosition("OUTPUT")).toEqual(STATION_POSITIONS.OUTPUT);
  });

  it("shares one table today, because it is one table", () => {
    expect(STATION_POSITIONS.INTAKE).toEqual(STATION_POSITIONS.OUTPUT);
    // The pickup mark is on that same table — the fixed spot an operator sets
    // a part on, which is what lets the machine work without a centroid in
    // ScanResult.
    expect(PICKUP_MARK).toEqual(STATION_POSITIONS.INTAKE);
  });
});

describe("clearances", () => {
  it("travels above every bin it could be carrying a part over", () => {
    const highest = Math.max(...SEED_BIN_CODES.map((code) => resolveBinPosition(code)!.zMM));
    expect(SAFE_TRAVEL_ZMM).toBeGreaterThan(highest);
  });

  it("retracts clear of the shelf before moving", () => {
    expect(RETRACTED_YMM).toBeLessThan(SHELF_GRID.origin.yMM + SHELF_GRID.approachDepthMM);
  });
});
