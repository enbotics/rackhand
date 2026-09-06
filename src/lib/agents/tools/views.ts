/**
 * Shapes catalog rows into the JSON the tools return.
 *
 * Data only — no prose. Tools hand the model structured facts and let it do
 * the writing; a tool that composes sentences makes its output impossible to
 * assert on and tempts the model to quote it verbatim.
 */
import type { Part } from "@/generated/prisma/client";

/** Just enough to name a part unambiguously. */
export interface PartRef {
  partId: string;
  sku: string;
  canonicalName: string;
}

export interface PartView extends PartRef {
  category: string | null;
  description: string | null;
  dimensions: {
    lengthMM: number | null;
    widthMM: number | null;
    heightMM: number | null;
  };
}

export function toPartRef(part: Part): PartRef {
  return { partId: part.id, sku: part.sku, canonicalName: part.canonicalName };
}

export function toPartView(part: Part): PartView {
  return {
    ...toPartRef(part),
    category: part.category,
    description: part.description,
    dimensions: {
      lengthMM: part.lengthMM,
      widthMM: part.widthMM,
      heightMM: part.heightMM,
    },
  };
}
