/**
 * The Warehouse Agent's approved tool list — its entire capability boundary.
 *
 * Nine READ-ONLY tools plus exactly ONE write tool: execute_retrieval.
 * Putaway is coordinated by request_guided_putaway, then performed only by
 * the deterministic guided dialog workflow. Every tool delegates to a warehouse service, repository
 * function or the GantryController; none holds a Prisma client, and there is
 * no generic escape hatch — no shell, bash, filesystem, file editor, arbitrary
 * HTTP, code execution, browser automation or database-query tool, and no
 * Strands vended tool is imported anywhere in this subsystem.
 *
 * The write capability is ONE high-level intent, never a set of primitives.
 * There is deliberately no reserve_bin, create_movement, add_inventory,
 * remove_inventory, update_bin, complete_movement, gantry_putaway or
 * gantry_retrieve: exposing those would let the model run the steps out of
 * order, or change inventory before the gantry moved. Retrieval asks its
 * deterministic service to perform the whole sequence; guided putaway writes
 * are available only through the dialog's deterministic workflow.
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
import { matchCatalogTool, MATCH_CATALOG_TOOL_NAME } from "./match-catalog";
import { executePutawayTool, EXECUTE_PUTAWAY_TOOL_NAME } from "./execute-putaway";
import { executeRetrievalTool, EXECUTE_RETRIEVAL_TOOL_NAME } from "./execute-retrieval";
import {
  requestGuidedPutawayTool,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
} from "./request-guided-putaway";
import {
  getGuidedPutawayStatusTool,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
} from "./get-guided-putaway-status";

export const WAREHOUSE_AGENT_TOOLS = [
  getGantryStatusTool,
  searchCatalogTool,
  getPartTool,
  searchInventoryTool,
  getBinStatusTool,
  listAvailableBinsTool,
  matchCatalogTool,
  requestGuidedPutawayTool,
  getGuidedPutawayStatusTool,
  executeRetrievalTool,
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
  SEARCH_CATALOG_TOOL_NAME,
  GET_PART_TOOL_NAME,
  SEARCH_INVENTORY_TOOL_NAME,
  GET_BIN_STATUS_TOOL_NAME,
  LIST_AVAILABLE_BINS_TOOL_NAME,
  MATCH_CATALOG_TOOL_NAME,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
] as const;

/** The state-changing tools, which always require approval. */
export const APPROVAL_REQUIRED_TOOL_NAMES = [
  EXECUTE_RETRIEVAL_TOOL_NAME,
] as const;

/** The names the agent is expected to expose, for assertion in tests and at startup. */
export const WAREHOUSE_AGENT_TOOL_NAMES = [
  GET_GANTRY_STATUS_TOOL_NAME,
  SEARCH_CATALOG_TOOL_NAME,
  GET_PART_TOOL_NAME,
  SEARCH_INVENTORY_TOOL_NAME,
  GET_BIN_STATUS_TOOL_NAME,
  LIST_AVAILABLE_BINS_TOOL_NAME,
  MATCH_CATALOG_TOOL_NAME,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
  EXECUTE_RETRIEVAL_TOOL_NAME,
] as const;

export {
  getGantryStatusTool,
  GET_GANTRY_STATUS_TOOL_NAME,
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
  matchCatalogTool,
  MATCH_CATALOG_TOOL_NAME,
  requestGuidedPutawayTool,
  REQUEST_GUIDED_PUTAWAY_TOOL_NAME,
  getGuidedPutawayStatusTool,
  GET_GUIDED_PUTAWAY_STATUS_TOOL_NAME,
  /** Legacy direct tool, exported for compatibility but not granted to the agent. */
  executePutawayTool,
  EXECUTE_PUTAWAY_TOOL_NAME,
  executeRetrievalTool,
  EXECUTE_RETRIEVAL_TOOL_NAME,
};
