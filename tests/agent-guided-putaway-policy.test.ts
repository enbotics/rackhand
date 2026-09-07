import { describe, expect, it } from "vitest";
import { WAREHOUSE_AGENT_PROMPT } from "@/lib/agents/warehouse-prompt";
import {
  APPROVAL_FREE_TOOL_NAMES,
  APPROVAL_REQUIRED_TOOL_NAMES,
  WAREHOUSE_AGENT_TOOL_NAMES,
  WAREHOUSE_AGENT_TOOLS,
} from "@/lib/agents/tools";

describe("warehouse agent guided putaway policy", () => {
  it("exposes one guided putaway path and no direct agent putaway executor", () => {
    expect(WAREHOUSE_AGENT_TOOL_NAMES).toContain("request_guided_putaway");
    expect(WAREHOUSE_AGENT_TOOL_NAMES).toContain("get_guided_putaway_status");
    expect(WAREHOUSE_AGENT_TOOL_NAMES).not.toContain("execute_putaway");
    expect(WAREHOUSE_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      ...WAREHOUSE_AGENT_TOOL_NAMES,
    ]);
    expect(APPROVAL_FREE_TOOL_NAMES).toContain("request_guided_putaway");
    expect(APPROVAL_FREE_TOOL_NAMES).toContain("get_guided_putaway_status");
    expect(APPROVAL_REQUIRED_TOOL_NAMES).toEqual(["execute_retrieval"]);
  });

  it("tells the model that the dialog—not the model—owns every putaway write", () => {
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/operator-guided workflow/i);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/dialog—not you—reserves the slot/i);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/do not claim the item is stored/i);
  });
});
