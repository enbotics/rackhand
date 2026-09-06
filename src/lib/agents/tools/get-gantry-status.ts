/**
 * The Warehouse Agent's only warehouse capability in this milestone.
 *
 * READ-ONLY. It reports gantry state and cannot move anything: it calls
 * `getStatus()` and nothing else. Deliberately routed through the
 * `GantryController` abstraction rather than `SimulatedGantryController`, so
 * the identical tool keeps working when real hardware replaces the simulator:
 *
 *   Strands tool -> getGantryController() -> GantryController -> simulator now, hardware later
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { getGantryController } from "@/lib/gantry/factory";
import { AgentError } from "../errors";

/**
 * No parameters today, but the schema is declared explicitly rather than
 * omitted — it sets the pattern the parameterised tools of a later milestone
 * will follow.
 */
export const getGantryStatusInputSchema = z.object({});

export const GET_GANTRY_STATUS_TOOL_NAME = "get_gantry_status";

export const getGantryStatusTool = tool({
  name: GET_GANTRY_STATUS_TOOL_NAME,
  description:
    "Return the current status of the warehouse gantry: its mode, state, current location, whether it is homed, any active operation id, and the last error. This tool is read-only and does not move the gantry or change any warehouse data.",
  inputSchema: getGantryStatusInputSchema,
  callback: async () => {
    try {
      // Real state from the running controller — never a fabricated reading.
      return await getGantryController().getStatus();
    } catch (err) {
      console.error("[warehouse-agent] get_gantry_status failed:", err);
      throw new AgentError("tool_execution_failed");
    }
  },
});
