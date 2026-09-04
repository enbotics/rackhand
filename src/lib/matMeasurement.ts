/**
 * Converts Gemini's pixel-space object corners into real mm using the
 * calibration mat's homography (lib/scan/matCalibration.ts) — the same
 * proven pixel<->mat-mm mapping parts-layout-planner's phone pipeline
 * relies on, just applied to a target object's corners instead of only
 * being used as a pre-flight legitimacy check.
 *
 * Unlike the retired rig-height + FOV approach, no assumption about camera
 * distance or lens field of view is involved at all — the homography's
 * `inverse` (image pixels -> mat millimetres) already IS the accurate,
 * per-shot pixel-to-mm mapping, derived from the mat's 4 QR corners of
 * known physical size and position. Edge lengths between mat-mm points are
 * real millimetres directly; no anisotropic pixel-scale math needed.
 */
import { unprojectImagePoint, type Homography, type Pt } from "./scan/homography";

export interface FractionalPoint {
  x: number;
  y: number;
}

export interface MatMeasurement {
  lengthMM: number;
  widthMM: number;
  angleDegrees: number;
}

/**
 * `corners` are Gemini's 4 object corners in fractional image coordinates
 * (0-1, top-left origin) — see lib/geminiMeasure.ts. Returns null if any
 * corner falls outside the homography's valid projection (should not
 * happen for a well-calibrated shot, but a degenerate homography or a
 * corner far outside the mat's fitted region can produce one).
 */
export function measureFromMatHomography(
  corners: [FractionalPoint, FractionalPoint, FractionalPoint, FractionalPoint],
  imageWidthPx: number,
  imageHeightPx: number,
  homography: Homography,
): MatMeasurement | null {
  const matPoints: Pt[] = [];
  for (const c of corners) {
    const imagePoint: Pt = { x: c.x * imageWidthPx, y: c.y * imageHeightPx };
    const matPoint = unprojectImagePoint(homography, imagePoint);
    if (!matPoint) return null;
    matPoints.push(matPoint);
  }

  const edge = (a: Pt, b: Pt) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { mm: Math.hypot(dx, dy), dx, dy };
  };

  const edge01 = edge(matPoints[0], matPoints[1]);
  const edge12 = edge(matPoints[1], matPoints[2]);

  const long = edge01.mm >= edge12.mm ? edge01 : edge12;
  const lengthMM = Math.max(edge01.mm, edge12.mm);
  const widthMM = Math.min(edge01.mm, edge12.mm);

  // Mat space is +X right, +Y up (see homography.ts) — angle is relative
  // to the mat's own bottom edge, same semantic as parts-layout-planner's
  // reported angleDegrees.
  let angleDegrees = Math.atan2(long.dy, long.dx) * (180 / Math.PI);
  angleDegrees = ((angleDegrees % 180) + 180) % 180;

  return { lengthMM, widthMM, angleDegrees };
}
