/**
 * Authoritative physical geometry of the printed calibration mat.
 *
 * Direct port of DimensionScanner/MatGeometry.swift — every value here was
 * read from the mat PDF's exact path coordinates, not estimated. See that
 * file for the full provenance notes; only the numbers are reproduced here.
 *
 * Mat coordinate system (canonical for the whole pipeline):
 *   origin (0,0) = placement-zone bottom-left corner
 *   +X -> right, +Y -> up, unit = millimetres
 */

export type MatCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export const MAT_CORNERS: MatCorner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

export const MAT_ID = "CALMAT-A4S-V0.1";

const SHORT_LABEL: Record<MatCorner, string> = {
  topLeft: "TL",
  topRight: "TR",
  bottomLeft: "BL",
  bottomRight: "BR",
};

/** Exact QR payload expected for this corner. Any other payload is ignored. */
export function expectedPayload(corner: MatCorner): string {
  return `${MAT_ID}-${SHORT_LABEL[corner]}`;
}

/** Reverse lookup: payload -> corner, or null if it doesn't match this mat revision. */
export function cornerFromPayload(payload: string): MatCorner | null {
  for (const corner of MAT_CORNERS) {
    if (expectedPayload(corner) === payload) return corner;
  }
  return null;
}

// --- Placement zone ---------------------------------------------------

export const placementZoneWidthMM = 160;
export const placementZoneHeightMM = 100;

/** Zone corners in cyclic order BL -> BR -> TR -> TL. */
export const placementZoneCorners: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: placementZoneWidthMM, y: 0 },
  { x: placementZoneWidthMM, y: placementZoneHeightMM },
  { x: 0, y: placementZoneHeightMM },
];

export const zoneCenter = { x: 80, y: 50 };

// --- QR markers ---------------------------------------------------------

/**
 * Each printed QR widget is exactly 24x24mm: a version-1 QR symbol
 * (21x21 modules) plus a 4-module quiet zone on every side, i.e. 29 modules
 * across. `corners` below is the on-device Vision detector's (or the
 * server's zedbar detector's) detected quadrilateral, which corresponds to
 * the 21-module symbol, quiet zone excluded.
 */
export const qrWidgetSizeMM = 24;
export const qrQuietZoneMM = (24 * 4) / 29; // ~3.310345
export const qrSymbolSizeMM = (24 * 21) / 29; // ~17.379310

/** Bottom-left corners of the four 24mm QR widgets, mat mm (exact). */
const qrWidgetOrigins: Record<MatCorner, { x: number; y: number }> = {
  topLeft: { x: -53.5, y: 108 },
  topRight: { x: 189.5, y: 108 },
  bottomLeft: { x: -53.5, y: -32 },
  bottomRight: { x: 189.5, y: -32 },
};

export interface QRMarker {
  corner: MatCorner;
  /** Physical center of the QR symbol (== widget center), mat mm. */
  center: { x: number; y: number };
  /**
   * The symbol's four physical corners in cyclic order
   * [mat-top-left, mat-top-right, mat-bottom-right, mat-bottom-left], where
   * "top" means larger +Y in mat coordinates.
   */
  corners: { x: number; y: number }[];
}

function buildQrMarkers(): Record<MatCorner, QRMarker> {
  const markers = {} as Record<MatCorner, QRMarker>;
  for (const corner of MAT_CORNERS) {
    const origin = qrWidgetOrigins[corner];
    const minX = origin.x + qrQuietZoneMM;
    const minY = origin.y + qrQuietZoneMM;
    const maxX = minX + qrSymbolSizeMM;
    const maxY = minY + qrSymbolSizeMM;
    markers[corner] = {
      corner,
      center: { x: origin.x + qrWidgetSizeMM / 2, y: origin.y + qrWidgetSizeMM / 2 },
      corners: [
        { x: minX, y: maxY },
        { x: maxX, y: maxY },
        { x: maxX, y: minY },
        { x: minX, y: minY },
      ],
    };
  }
  return markers;
}

export const qrMarkers = buildQrMarkers();

/** Center-connection order for the mat quadrilateral: TL -> TR -> BR -> BL (-> TL). */
export const polygonOrder: MatCorner[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

// --- Printed content inside the placement zone (for the ink mask) ------

export interface MatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Axis-aligned mat-millimetre boxes covering printed text INSIDE the
 * 160x100mm zone. Used to exclude printed ink from the reference-free
 * foreground mask.
 */
export const printedTextBoxes: MatRect[] = [
  // "PLACE ONE ITEM INSIDE THIS 160 x 100 mm ZONE" — baseline y = 92mm
  { x: 42.0, y: 90.4, width: 78.0, height: 4.4 },
  // "Keep the item and surrounding objects away from the border" — y = 4mm
  { x: 43.5, y: 2.6, width: 74.0, height: 3.8 },
  // "ORIGIN (0,0)" — y = 3mm
  { x: 2.2, y: 2.2, width: 22.0, height: 4.0 },
  // "+X" — y = 3mm, near the right edge
  { x: 151.5, y: 2.2, width: 8.0, height: 4.0 },
  // "+Y" — y = 95mm, near the left edge
  { x: 2.2, y: 94.2, width: 8.0, height: 4.0 },
];

/** Crosshair tick marks printed at the zone center (80, 50). */
export const crosshairLines: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [
  { start: { x: 75, y: 50 }, end: { x: 85, y: 50 } },
  { start: { x: 80, y: 45 }, end: { x: 80, y: 55 } },
];

/** Radius of the printed center crosshair circle. */
export const centerSymbolRadiusMM = 3.0;

/** Ruler tick marks run along the zone's bottom and left edges within this band. */
export const edgeTickBandMM = 2.0;
