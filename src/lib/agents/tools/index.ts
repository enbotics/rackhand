/**
 * The Warehouse Agent's approved tool list — its entire capability boundary.
 *
 * Nine READ-ONLY tools plus four high-level physical tools: execute_putaway,
 * execute_retrieval, execute_inventory_audit and verify_materials_availability
 * (the one approval-free physical tool — see its entry in
 * APPROVAL_FREE_TOOL_NAMES for why). The Inventory Auditor and Materials
 * Planner agents are mounted dynamically by warehouse-agent.ts as additional
 * read-only orchestration tools for client calls. Every tool delegates to a warehouse service, repository
 * function or the GantryController; none holds a Prisma client, and there is
 * no generic escape hatch — no shell, bash, filesystem, file editor, arbitrary
 * HTTP, code execution, browser automation or database-query tool. Strands
 * GoalLoop and MemoryManager are internal agent plugins, not callable tools.
 *
 * Each write capability is one high-level atomic workflow, never a set of primitives.
 * There is deliberately no reserve_bin, create_movement, add_inventory,
 * remove_inventory, update_bin, complete_movement, gantry_putaway or
 * gantry_retrieve: exposing those would let the model run the steps out of
 * order, or change inventory before the gantry moved. Retrieval asks its
 * deterministic service to perform the whole sequence.
 *
 * Still absent entirely: create_part, any direct inventory or bin mutation,
 * and any direct gantry control. A test asserts this list contains none.
 *
 * One list, used both to construct the agent and to assert the boundary, so a
 * capability cannot be granted in one place and forgotten in another.
 */
import { getGantryStatusTool, GET_GANTRY_STATUS_TOOL_NAME } from "./get-gantry-status";
import { searchCatalogTool, SEARCH_CATALOG_TOOL_NAME } from "./search-catalog";
import { getPartTool, GET_PART_TOOL_NAME } from "./get-part";
import { searchInventoryTool, SEARCH_INVENTORY_TOOL_NAME } from "./search-inventory";
import { getBinStatusTool, GET_BIN_STATUS_TOOL_NAME } from "./get-bin-status";
import { listAvailableBinsTool, LIST_AVAILABLE_BINS_TOOL_NAME } from "./list-available-bins";
import { listBinsTool, LIST_BINS_TOOL_NAME } from "./list-bins";
import { matchCatalogTool, MATCH_CATALOG_TOOL_NAME } from "./match-catalog";
import { executePutawayTool, EXECUTE_PUTAWAY_TOOL_NAME } from "./execute-putaway";
import { executeRetrievalTool, EXECUTE_RETRIEVAL_TOOL_NAME } from "./execute-retrieval";
import {
  executeInventoryAuditTool,
  EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
} from "./execute-inventory-audit";
import { INVENTORY_AUDITOR_TOOL_NAME } from "../inventory-auditor-agent";
import { MATERIALS_PLANNER_TOOL_NAME } from "../materials-planner-agent";
import {
  verifyMaterialsAvailabilityTool,
  VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
} from "./verify-materials-availability";
import {
  requestGuidedPutawayTool,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
} from "./request-guided-putaway";
import {
  getGuidedPutawayStatusTool,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
} from "./get-guided-putaway-status";
import {
  observeDailyBinActivityTool,
  OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME,
} from "./observe-daily-bin-activity";

export const WAREHOUSE_AGENT_TOOLS = [
  getGantryStatusTool,
  observeDailyBinActivityTool,
  searchCatalogTool,
  getPartTool,
  searchInventoryTool,
  getBinStatusTool,
  listAvailableBinsTool,
  listBinsTool,
  matchCatalogTool,
  executePutawayTool,
  executeRetrievalTool,
  executeInventoryAuditTool,
  verifyMaterialsAvailabilityTool,
];

/**
 * The tools that may run WITHOUT human approval — the Human-in-the-Loop
 * allowlist (Milestone 9).
 *
 * An explicit list of read-only names, not an LLM risk classifier: we already
 * know exactly which tools change warehouse state, and a deterministic policy
 * cannot be talked out of its decision. Anything absent here requires approval
 * by default, so a future tool is gated unless someone deliberately adds it.
 */
export const APPROVAL_FREE_TOOL_NAMES = [
  GET_GANTRY_STATUS_TOOL_NAME,
  OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME,
  SEARCH_CATALOG_TOOL_NAME,
  GET_PART_TOOL_NAME,
  SEARCH_INVENTORY_TOOL_NAME,
  GET_BIN_STATUS_TOOL_NAME,
  LIST_AVAILABLE_BINS_TOOL_NAME,
  LIST_BINS_TOOL_NAME,
  MATCH_CATALOG_TOOL_NAME,
  INVENTORY_AUDITOR_TOOL_NAME,
  MATERIALS_PLANNER_TOOL_NAME,
  /**
   * The one deliberate exception to "every physical write tool requires
   * approval" in this app. verify_materials_availability moves bins, but
   * only ever the ones a materials_planner call itself just identified as
   * real, currently-stocked requirements — it never retrieves or puts away
   * anything, only photographs bins that are already on the shelf and puts
   * them right back. The user explicitly chose zero confirmation gate for
   * this flow (the operator already approved the *idea* by asking what a
   * build needs); requiring a click per bin would turn "check my stock"
   * into a click-through chore with no safety benefit, since nothing here
   * can leave the warehouse.
   */
  VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
] as const;

/** The state-changing tools, which always require approval. */
export const APPROVAL_REQUIRED_TOOL_NAMES = [
  EXECUTE_PUTAWAY_TOOL_NAME,
  EXECUTE_RETRIEVAL_TOOL_NAME,
  EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
] as const;

/** The names the agent is expected to expose, for assertion in tests and at startup. */
export const WAREHOUSE_AGENT_TOOL_NAMES = [
  GET_GANTRY_STATUS_TOOL_NAME,
  OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME,
  SEARCH_CATALOG_TOOL_NAME,
  GET_PART_TOOL_NAME,
  SEARCH_INVENTORY_TOOL_NAME,
  GET_BIN_STATUS_TOOL_NAME,
  LIST_AVAILABLE_BINS_TOOL_NAME,
  LIST_BINS_TOOL_NAME,
  MATCH_CATALOG_TOOL_NAME,
  EXECUTE_PUTAWAY_TOOL_NAME,
  EXECUTE_RETRIEVAL_TOOL_NAME,
  EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  INVENTORY_AUDITOR_TOOL_NAME,
  MATERIALS_PLANNER_TOOL_NAME,
  VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
] as const;

export {
  getGantryStatusTool,
  GET_GANTRY_STATUS_TOOL_NAME,
  observeDailyBinActivityTool,
  OBSERVE_DAILY_BIN_ACTIVITY_TOOL_NAME,
  searchCatalogTool,
  SEARCH_CATALOG_TOOL_NAME,
  getPartTool,
  GET_PART_TOOL_NAME,
  searchInventoryTool,
  SEARCH_INVENTORY_TOOL_NAME,
  getBinStatusTool,
  GET_BIN_STATUS_TOOL_NAME,
  listAvailableBinsTool,
  LIST_AVAILABLE_BINS_TOOL_NAME,
  listBinsTool,
  LIST_BINS_TOOL_NAME,
  matchCatalogTool,
  MATCH_CATALOG_TOOL_NAME,
  requestGuidedPutawayTool,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
  getGuidedPutawayStatusTool,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
  executePutawayTool,
  EXECUTE_PUTAWAY_TOOL_NAME,
  executeRetrievalTool,
  EXECUTE_RETRIEVAL_TOOL_NAME,
  executeInventoryAuditTool,
  EXECUTE_INVENTORY_AUDIT_TOOL_NAME,
  verifyMaterialsAvailabilityTool,
  VERIFY_MATERIALS_AVAILABILITY_TOOL_NAME,
};
