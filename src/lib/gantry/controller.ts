/**
 * The contract every gantry implementation satisfies — the whole point of
 * this milestone.
 *
 * Callers ask for warehouse-level intent ("put this away in B2-01"), never for
 * axes or steps. That keeps the rest of the application, and the later
 * Strands tool, identical whether a simulator or real hardware is underneath;
 * swapping them is a factory change, not an application change.
 *
 * Deliberately absent: anything about inventory. A controller executes
 * movement and reports what happened. What the warehouse then believes about
 * stock is the warehouse service layer's decision, in a later milestone.
 */
import type {
  BinPresentationRequest,
  BinReturnRequest,
  GantryOperation,
  GantryStatus,
  PutawayRequest,
  RetrievalRequest,
} from "./types";

export interface GantryController {
  /** Current machine state. Never throws. */
  getStatus(): Promise<GantryStatus>;

  /** Establish the reference position. */
  home(): Promise<GantryOperation>;

  /** Move a part from the intake station into a storage bin. */
  putaway(input: PutawayRequest): Promise<GantryOperation>;

  /** Move a part from a storage bin to the output station. */
  retrieve(input: RetrievalRequest): Promise<GantryOperation>;

  /** Bring a selected storage bin to the operator for loading. */
  presentBin(input: BinPresentationRequest): Promise<GantryOperation>;

  /** Return a presented bin to its reserved storage slot. */
  returnBin(input: BinReturnRequest): Promise<GantryOperation>;

  /** Most recent operations, newest first. */
  getRecentOperations(limit?: number): Promise<GantryOperation[]>;
}
