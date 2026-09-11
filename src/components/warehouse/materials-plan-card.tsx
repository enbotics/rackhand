"use client";

import type { MaterialRequirementView } from "@/lib/warehouse/dashboard-types";
import { Field } from "./ui";

/**
 * Step 1 of the build-plan pipeline: the Materials Planner's own requirements
 * list, rendered the moment it comes back in the chat reply — before the stock
 * check has even started.
 *
 * WHY THIS IS NO LONGER ITS OWN PANEL: the planner's list and the stock check
 * that immediately follows it are two halves of ONE answer to one question
 * ("what do I need for this build?"). Rendered as two free-floating panels they
 * read as two unrelated events, which is exactly what an operator reported as
 * confusing. MaterialsPlanPipelineCard now owns the framing and numbers the
 * stages; this renders only the body of the first one.
 *
 * WHY Field RATHER THAN PLAIN TEXT: purpose, part number, category and
 * quantity are four different kinds of fact about one row. Four unlabelled
 * lines make the operator work out which is which; the shared Field row
 * already carries this app's label/value treatment everywhere else.
 */
export function MaterialsPlanStage({
  requirements,
}: {
  requirements: MaterialRequirementView[];
}) {
  if (requirements.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-faint">
        The planner did not return any items for this build.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed text-ink-muted">
        {requirements.length} item{requirements.length === 1 ? "" : "s"} identified for this
        build, each matched to a part that really exists in the catalog.
      </p>
      <ol className="space-y-1.5">
        {requirements.map((req, index) => (
          <li
            key={`${req.sku}-${index}`}
            className="rounded-lg border border-line bg-bg-elevated px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-xs font-medium leading-relaxed text-ink">
                {req.purpose}
              </p>
              <span className="shrink-0 rounded-md border border-accent-soft/40 bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-accent">
                {req.quantity}×
              </span>
            </div>
            <div className="mt-1.5 border-t border-line-soft pt-1">
              <Field label="Part">{req.sku}</Field>
              <Field label="Category">{req.category}</Field>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
