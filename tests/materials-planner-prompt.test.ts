import { describe, expect, it } from "vitest";
import { MATERIALS_PLANNER_PROMPT } from "@/lib/agents/materials-planner-prompt";

describe("materials planner prompt", () => {
  it("preserves every material in an explicit multi-item Sheet BOM", () => {
    expect(MATERIALS_PLANNER_PROMPT).toContain(
      "resolve every material separately",
    );
    expect(MATERIALS_PLANNER_PROMPT).toContain(
      "must contain that many distinct, stocked requirements",
    );
    expect(MATERIALS_PLANNER_PROMPT).toContain(
      "Never collapse several required hints into one generic substitute",
    );
    expect(MATERIALS_PLANNER_PROMPT).toContain(
      "must never merge distinct required hints",
    );
    expect(MATERIALS_PLANNER_PROMPT).toContain(
      "resolve every row's Material Hints and return all distinct stocked requirements",
    );
  });
});
