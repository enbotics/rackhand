/**
 * Agent-facing failures, in the same `{ error: { code, message } }` envelope
 * the rest of the app uses.
 *
 * Every code carries a fixed, safe client message. The underlying error —
 * which for Bedrock can contain account ids, ARNs, role names or token
 * details — is logged server-side and never returned to the browser.
 */

export const AGENT_ERROR_STATUS = {
  /** Bad or missing message in the request body. */
  agent_invalid_request: 422,
  /** The model could not be reached: credentials, region, or model access. */
  agent_model_unavailable: 503,
  /** The model was reachable but the invocation failed. */
  agent_invocation_failed: 500,
  /** A warehouse tool threw while the agent was using it. */
  tool_execution_failed: 500,
} as const;

export type AgentErrorCode = keyof typeof AGENT_ERROR_STATUS;

/** What the browser is allowed to see. Deliberately free of provider detail. */
const SAFE_MESSAGES: Record<AgentErrorCode, string> = {
  agent_invalid_request: "The request body was not a valid agent message.",
  agent_model_unavailable:
    "The Warehouse Agent could not reach its Bedrock model. Check AWS credentials, region, and Bedrock model access.",
  agent_invocation_failed: "The Warehouse Agent failed to complete this request.",
  tool_execution_failed: "A warehouse tool failed while the Warehouse Agent was using it.",
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  /** Field-level detail — only ever populated for agent_invalid_request, which contains no secrets. */
  readonly issues: string[];

  constructor(code: AgentErrorCode, issues: string[] = []) {
    super(SAFE_MESSAGES[code]);
    this.name = "AgentError";
    this.code = code;
    this.issues = issues;
  }

  get status(): number {
    return AGENT_ERROR_STATUS[this.code];
  }

  /** The only representation that may cross the network. */
  toResponseBody(): { error: { code: AgentErrorCode; message: string; issues?: string[] } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues.length > 0 ? { issues: this.issues } : {}),
      },
    };
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

/**
 * Markers that mean "we never got to the model" rather than "the model
 * failed" — credential resolution, expired sessions, denied model access, an
 * unknown model id or region. Matched on error name and message because the
 * AWS SDK surfaces these as differently-shaped exceptions depending on where
 * in the chain they occur.
 */
const MODEL_UNAVAILABLE_MARKERS = [
  "credential",
  "accessdenied",
  "access is denied",
  "unrecognizedclient",
  "expiredtoken",
  "invalidsignature",
  "resourcenotfound",
  "validationexception",
  "could not load credentials",
  "region is missing",
  "unable to determine",
  "security token",
  "notauthorized",
  "not authorized",
  "getaddrinfo",
  "enotfound",
  // Account-level entitlement, not a code fault: the model is real and the
  // caller is authenticated, but Bedrock will not serve it to this account.
  "payment instrument",
  "marketplace subscription",
];

/** Bounded so a self-referential cause chain cannot spin. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Flattens an error and its `cause` chain into one lowercase haystack.
 *
 * Strands wraps the AWS SDK exception in a `ModelError` whose own name and
 * message carry none of the SDK markers — the `AccessDeniedException` lives in
 * `cause`. Classifying on the top-level error alone therefore mislabels every
 * wrapped credential and access failure as a generic invocation failure.
 */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(" ").toLowerCase();
}

/**
 * Classifies a thrown error into an AgentError without leaking its content.
 * Only the classification crosses the boundary; the original is logged.
 */
export function classifyAgentFailure(err: unknown): AgentError {
  if (isAgentError(err)) return err;

  const haystack = collectErrorText(err);

  if (MODEL_UNAVAILABLE_MARKERS.some((marker) => haystack.includes(marker))) {
    return new AgentError("agent_model_unavailable");
  }
  return new AgentError("agent_invocation_failed");
}
