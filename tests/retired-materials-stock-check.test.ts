import { describe, expect, it } from "vitest";
import {
  APPROVAL_FREE_TOOL_NAMES,
  WAREHOUSE_AGENT_TOOL_NAMES,
} from "@/lib/agents/tools";
import { materialsCheckVerdict } from "@/components/warehouse/materials-check-progress-card";
import type { MaterialsPlanCheckView } from "@/lib/warehouse/dashboard-types";

describe("retired materials stock check", () => {
  it("is absent from both the agent capability and approval-free boundaries", () => {
    expect(WAREHOUSE_AGENT_TOOL_NAMES).not.toContain("verify_materials_availability");
    expect(APPROVAL_FREE_TOOL_NAMES).not.toContain("verify_materials_availability");
  });

  it("never presents a zero-bin historical report as confirmed shortage", () => {
    const check: MaterialsPlanCheckView = {
      id: "legacy-check",
      requirements: [
        {
          sku: "SCREW-M4-30",
          purpose: "secure the frame",
          category: "fastener",
          quantity: 4,
        },
      ],
      status: "COMPLETED",
      binsPlanned: 0,
      binsCompleted: 0,
      currentBinCode: null,
      results: [
        {
          sku: "SCREW-M4-30",
          required: 4,
          available: 0,
          status: "SHORTAGE",
        },
      ],
      createdAt: 0,
      completedAt: 1,
    };

    expect(materialsCheckVerdict(check)).toMatchObject({
      chip: { label: "UNVERIFIED" },
      headline: "Stock was not verified",
    });
  });
});
