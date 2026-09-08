import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { observeDailyBinActivity } from "@/lib/warehouse/audit-activity-service";

export const OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME = "observe_daily_bin_activity";

export const observeDailyBinActivityTool = tool({
  name: OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME,
  description:
    "Read the rolling 24-hour movement and audit activity of shelf bins, ranked for possible inventory auditing. This is observation only: it never schedules an audit, moves the gantry or changes inventory.",
  inputSchema: z.object({}),
  callback: async () => observeDailyBinActivity(),
});
