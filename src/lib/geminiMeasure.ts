/**
 * One Gemini call per measurement request. Gemini is asked ONLY to locate
 * the physical object (name it, and find the 4 corners of its minimum
 * bounding rectangle) — never to estimate any physical measurement itself.
 * Every mm number is computed afterward in lib/matMeasurement.ts from those
 * pixel corners plus the calibration mat's homography (see
 * app/api/measure/route.ts and lib/scan/matCalibration.ts) — the same
 * "Gemini localizes, code measures" split parts-layout-planner's
 * lib/scan/pipeline.ts documents for why it moved off classical
 * segmentation: Gemini generalizes across arbitrary shape/color/material
 * far better than segmentation.ts ever did, but its own sense of absolute
 * scale is not trusted.
 *
 * The mat is now in every photo alongside the object, so the prompt tells
 * Gemini to ignore the mat's own printed graphics (QR codes, ruler, grid)
 * and locate only the physical part resting on it.
 *
 * Plain REST fetch, not the SDK — one call with a fixed shape, same
 * reasoning as parts-layout-planner's lib/scan/gemini.ts.
 */
import sharp from "sharp";

const MODEL = "gemini-3.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Long-side cap before sending to Gemini — keeps the call to one 768x768 image tile (flat token cost regardless of the CM717's native 2K/4MP capture). */
const MAX_IMAGE_DIMENSION_PX = 1024;

/** Below this, a returned height is dropped rather than trusted — see prompt: a single overhead frame has no vertical ruler, so height is inherently the shakiest of the three numbers. */
const MIN_HEIGHT_CONFIDENCE = 0.5;

const PROMPT = `This photo was taken by a webcam mounted directly overhead, looking straight down at a printed calibration mat lying on a flat work surface. The mat itself has 4 small QR-code squares near its corners and a ruled rectangular zone with tick marks and grid lines printed on it — IGNORE all of that printed mat graphics entirely, it is not the object. Exactly one physical object rests on top of the mat, inside its ruled zone.

Do not estimate any physical measurement yourself — any size guess of yours would be unreliable, the actual mm conversion is done separately from the mat's own markings. Instead:

1. Find the physical object's minimum-area bounding rectangle as it appears in the IMAGE (the real part resting on the mat — never the mat's printed QR codes, ruler ticks, grid lines, or text). Report its 4 corners in cyclic order (so consecutive corners share an edge, not a diagonal) using your normal 0-1000 normalized image coordinate convention: x = 0 at the left edge, 1000 at the right edge; y = 0 at the top edge, 1000 at the bottom edge. Be as tight as possible — the rectangle should hug the object, not include surrounding mat surface.
2. name: a short, concrete, human-readable name for the object (e.g. "Blue plastic USB hub", "M6 hex bolt") — specific enough to distinguish it from a similar item, not a generic category.
3. description: one concise sentence on distinguishing features (material, color, notable markings).
4. Separately, attempt the object's height above the surface (heightMM) using whatever perspective, shadow, or occlusion cues the photo offers — this is inherently uncertain from a single straight-down shot, since there is no vertical ruler the way there is a ground plane. Report heightConfidence (0 to 1) honestly; if you cannot form a reasonable estimate, set heightMM to null and heightConfidence to 0.
5. dimensionConfidence: 0 to 1, your confidence in how tightly the bounding rectangle fits the object (not a confidence in any mm value — you are not asked for one).

If no object is visible on the mat (only the mat's own printed graphics), set objectDetected to false. If more than one distinct physical object is visible, set multipleObjects to true. In either case the corner/numeric fields are ignored, but still fill corners with four (0,0) points and name/description with empty strings.`;

/** Gemini's own trained spatial-grounding convention for any bounding-box-shaped answer — asking in plain 0-1 fractions gets silently ignored in favor of this, so the prompt/schema now asks for it directly instead of fighting it. */
const COORDINATE_SPACE_MAX = 1000;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    objectDetected: { type: "BOOLEAN" },
    multipleObjects: { type: "BOOLEAN" },
    name: { type: "STRING" },
    description: { type: "STRING" },
    corners: {
      type: "ARRAY",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "OBJECT",
        properties: { x: { type: "INTEGER" }, y: { type: "INTEGER" } },
        required: ["x", "y"],
      },
    },
    heightMM: { type: "NUMBER", nullable: true },
    heightConfidence: { type: "NUMBER" },
    dimensionConfidence: { type: "NUMBER" },
  },
  required: [
    "objectDetected",
    "multipleObjects",
    "name",
    "description",
    "corners",
    "heightMM",
    "heightConfidence",
    "dimensionConfidence",
  ],
} as const;

/** Normalized to a 0-1 fraction (already converted from Gemini's native 0-1000 scale — see asCorners) so lib/matMeasurement.ts's FractionalPoint contract stays the same regardless of what coordinate space Gemini itself answers in. */
export interface GeminiCorner {
  x: number;
  y: number;
}

export interface GeminiMeasurement {
  name: string;
  description: string;
  corners: [GeminiCorner, GeminiCorner, GeminiCorner, GeminiCorner];
  heightMM: number | null;
  dimensionConfidence: number;
}

export interface GeminiUsage {
  model: string;
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
}

export type GeminiOutcome =
  | { ok: true; measurement: GeminiMeasurement; usage: GeminiUsage }
  | { ok: false; reason: "no_object_detected" | "multiple_objects"; usage: GeminiUsage };

async function prepareImage(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg)
    .resize({ width: MAX_IMAGE_DIMENSION_PX, height: MAX_IMAGE_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Clamps to Gemini's native [0, 1000] coordinate space, then normalizes to a 0-1 fraction. */
function asCorners(value: unknown): [GeminiCorner, GeminiCorner, GeminiCorner, GeminiCorner] {
  const fallback: GeminiCorner = { x: 0, y: 0 };
  if (!Array.isArray(value) || value.length !== 4) return [fallback, fallback, fallback, fallback];
  const parsed = value.map((c) => {
    const obj = c as { x?: unknown; y?: unknown };
    const x = asFiniteNumber(obj?.x);
    const y = asFiniteNumber(obj?.y);
    return {
      x: x != null ? Math.min(Math.max(x, 0), COORDINATE_SPACE_MAX) / COORDINATE_SPACE_MAX : 0,
      y: y != null ? Math.min(Math.max(y, 0), COORDINATE_SPACE_MAX) / COORDINATE_SPACE_MAX : 0,
    };
  });
  return [parsed[0], parsed[1], parsed[2], parsed[3]];
}

/**
 * Throws on transport/API failure — caller surfaces that as a 502, matching
 * every other transient-failure convention in this codebase's sibling
 * project. Only returns `ok: false` for a legitimate semantic answer from
 * Gemini itself (no object, more than one object).
 */
export async function measureWithGemini(imageJPEG: Buffer): Promise<GeminiOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (see .env.local)");

  const prepared = await prepareImage(imageJPEG);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: "image/jpeg", data: prepared.toString("base64") } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini request failed: ${response.status} ${text}`);
  }

  const body = await response.json();
  const usage: GeminiUsage = {
    model: MODEL,
    promptTokens: body?.usageMetadata?.promptTokenCount ?? 0,
    candidateTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
    thoughtsTokens: body?.usageMetadata?.thoughtsTokenCount ?? 0,
    totalTokens: body?.usageMetadata?.totalTokenCount ?? 0,
  };

  const text: string | undefined = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response had no text part");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini response was not valid JSON: ${text.slice(0, 200)}`);
  }

  if (parsed.multipleObjects === true) return { ok: false, reason: "multiple_objects", usage };
  if (parsed.objectDetected === false) return { ok: false, reason: "no_object_detected", usage };

  const heightMMRaw = asFiniteNumber(parsed.heightMM);
  const heightConfidence = asFiniteNumber(parsed.heightConfidence) ?? 0;
  const heightMM = heightMMRaw != null && heightMMRaw > 0 && heightConfidence >= MIN_HEIGHT_CONFIDENCE ? heightMMRaw : null;

  return {
    ok: true,
    measurement: {
      name: asString(parsed.name).trim() || "Unnamed item",
      description: asString(parsed.description).trim(),
      corners: asCorners(parsed.corners),
      heightMM,
      dimensionConfidence: Math.min(Math.max(asFiniteNumber(parsed.dimensionConfidence) ?? 0.5, 0), 1),
    },
    usage,
  };
}
