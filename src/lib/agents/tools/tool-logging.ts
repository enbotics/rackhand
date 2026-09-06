/**
 * Shared logging and failure handling for warehouse tools.
 *
 * Logged: tool name, sanitized input echo, coarse result summary. Never
 * logged: credentials, API keys, images, prompts, or model reasoning. Full
 * observability is a later milestone; this is one grep-able line per call.
 */
import { AgentError } from "../errors";

export function logTool(name: string, input: string, result: string): void {
  console.log(`[warehouse-tool] tool=${name} ${input} result=${result}`);
}

/**
 * For genuinely unexpected failures only — a database that is down, a service
 * that threw. Normal domain absences (no such part, no such bin) are
 * structured results instead, because a thrown error tells the model far less
 * than `{ found: false, reason: "part_not_found" }` does.
 *
 * The underlying error stays in the server log; the model and the client see
 * only the fixed safe AgentError message.
 */
export function toolFailure(name: string, err: unknown): never {
  console.error(`[warehouse-tool] tool=${name} failed:`, err);
  throw new AgentError("tool_execution_failed");
}
