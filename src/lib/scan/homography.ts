/**
 * Direct port of DimensionScanner/Homography.swift.
 *
 * Fits a mat-mm -> image-pixel homography from >=4 correspondences via
 * Hartley-normalized least squares (DLT-style rows accumulated into an 8x8
 * normal-equations system, not a raw 4-point exact solve — more
 * correspondences make the fit more robust, not just re-derive the same
 * answer).
 *
 * Coordinate systems:
 *   - Mat: millimetres, bottom-left origin, +X right, +Y up.
 *   - Image pixels: native captured-image resolution, top-left origin, +Y
 *     down.
 */

export interface Pt {
  x: number;
  y: number;
}

/** 3x3 matrix, row-major, length 9: [a,b,c, d,e,f, g,h,i]. */
type Mat3 = number[];

export interface Homography {
  forward: Mat3; // mat mm -> image pixels
  inverse: Mat3; // image pixels -> mat mm
  imagePixelSize: { width: number; height: number };
}

function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

function determinant3(m: Mat3): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c11 = e * i - f * h;
  const c12 = -(d * i - f * g);
  const c13 = d * h - e * g;
  const c21 = -(b * i - c * h);
  const c22 = a * i - c * g;
  const c23 = -(a * h - b * g);
  const c31 = b * f - c * e;
  const c32 = -(a * f - c * d);
  const c33 = a * e - b * d;

  const det = a * c11 + b * c12 + c * c13;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;

  const out = [
    c11 * invDet, c21 * invDet, c31 * invDet,
    c12 * invDet, c22 * invDet, c32 * invDet,
    c13 * invDet, c23 * invDet, c33 * invDet,
  ];
  return out.every(Number.isFinite) ? out : null;
}

function applyMatrix(m: Mat3, p: Pt): Pt | null {
  const x = m[0] * p.x + m[1] * p.y + m[2];
  const y = m[3] * p.x + m[4] * p.y + m[5];
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!Number.isFinite(w) || Math.abs(w) <= 1e-12) return null;
  const rx = x / w;
  const ry = y / w;
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  return { x: rx, y: ry };
}

export function projectMatPoint(h: Homography, p: Pt): Pt | null {
  return applyMatrix(h.forward, p);
}

export function unprojectImagePoint(h: Homography, p: Pt): Pt | null {
  return applyMatrix(h.inverse, p);
}

/** Mat mm -> normalized [0,1] canonical image coordinates (top-left origin). */
export function matMillimetersToCanonicalImage(h: Homography, p: Pt): Pt | null {
  const projected = projectMatPoint(h, p);
  if (!projected) return null;
  const x = projected.x / h.imagePixelSize.width;
  const y = projected.y / h.imagePixelSize.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Normalized [0,1] canonical image coordinates -> mat mm. */
export function imagePointToMatMillimeters(h: Homography, normalized: Pt): Pt | null {
  const denormalized = {
    x: normalized.x * h.imagePixelSize.width,
    y: normalized.y * h.imagePixelSize.height,
  };
  return unprojectImagePoint(h, denormalized);
}

// --- Fitting -------------------------------------------------------------

interface Similarity {
  matrix: Mat3;
}

/** Hartley normalization: translate centroid to origin, scale mean distance to sqrt(2). */
function computeNormalization(points: Pt[]): Similarity | null {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    meanDist += Math.sqrt(dx * dx + dy * dy);
  }
  meanDist /= n;
  if (!(meanDist > 1e-9)) return null;

  const s = Math.SQRT2 / meanDist;
  return {
    matrix: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
  };
}

/** Applies a similarity transform (bottom row is always [0,0,1], no perspective divide needed). */
function applySimilarity(m: Mat3, p: Pt): Pt {
  return { x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] };
}

function accumulateRow(ata: number[], atb: number[], row: number[], b: number): void {
  for (let r = 0; r < 8; r++) {
    atb[r] += row[r] * b;
    for (let c = 0; c < 8; c++) {
      ata[r * 8 + c] += row[r] * row[c];
    }
  }
}

/** Gaussian elimination with partial pivoting over an n x n system. */
function solveLinearSystem(aFlat: number[], b: number[], n: number): number[] | null {
  const a: number[][] = [];
  for (let r = 0; r < n; r++) {
    const row = new Array(n + 1);
    for (let c = 0; c < n; c++) row[c] = aFlat[r * n + c];
    row[n] = b[r];
    a.push(row);
  }

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxValue = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > maxValue) {
        maxValue = v;
        maxRow = r;
      }
    }
    if (maxValue <= 1e-12) return null;
    if (maxRow !== col) {
      const tmp = a[col];
      a[col] = a[maxRow];
      a[maxRow] = tmp;
    }

    const pivot = a[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / pivot;
      if (!Number.isFinite(factor)) return null;
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }

  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = a[r][n];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    const v = sum / a[r][r];
    if (!Number.isFinite(v)) return null;
    x[r] = v;
  }
  return x;
}

/**
 * Fits a homography from >=4 (mat, image) correspondences.
 *
 * Two-stage callers (see matCalibration.ts) typically call this once with 4
 * marker centers for a preliminary fit, then again with all 16 matched
 * corner points for the final fit.
 */
export function fitHomography(
  pairs: { mat: Pt; image: Pt }[],
  imagePixelSize: { width: number; height: number },
): Homography | null {
  if (pairs.length < 4) return null;

  const tMat = computeNormalization(pairs.map((p) => p.mat));
  const tImg = computeNormalization(pairs.map((p) => p.image));
  if (!tMat || !tImg) return null;

  const ata = new Array(64).fill(0);
  const atb = new Array(8).fill(0);

  for (const pair of pairs) {
    const p = applySimilarity(tMat.matrix, pair.mat);
    const q = applySimilarity(tImg.matrix, pair.image);

    accumulateRow(ata, atb, [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], q.x);
    accumulateRow(ata, atb, [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], q.y);
  }

  const h = solveLinearSystem(ata, atb, 8);
  if (!h) return null;

  const normalized: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

  const tImgInv = invert3(tImg.matrix);
  if (!tImgInv) return null;

  const forward = multiply3(multiply3(tImgInv, normalized), tMat.matrix);
  if (!forward.every(Number.isFinite)) return null;

  const det = determinant3(forward);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) return null;

  const inverse = invert3(forward);
  if (!inverse) return null;

  // Round-trip sanity check: forward*inverse must be the identity (up to its
  // own homogeneous scale) to 1e-6. A real correctness gate, not decoration
  // — reject the whole fit rather than trust a numerically bad solve.
  const identity = multiply3(forward, inverse);
  const scale = identity[8];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return null;
  const normalizedIdentity = identity.map((v) => v / scale);
  const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let k = 0; k < 9; k++) {
    if (Math.abs(normalizedIdentity[k] - expected[k]) > 1e-6) return null;
  }

  return { forward, inverse, imagePixelSize };
}
