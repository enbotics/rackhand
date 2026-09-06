import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "@strands-agents/sdk";
import { AgentError, classifyAgentFailure, isAgentError } from "@/lib/agents/errors";
import {
  MAX_AGENT_MESSAGE_LENGTH,
  WAREHOUSE_AGENT_NAME,
  EMPTY_REPLY_FALLBACK,
  IDENTITY_RESOLVED_NOTICE,
  SCAN_ATTACHED_NOTICE,
  createWarehouseAgent,
  invokeWarehouseAgent,
  validateAgentScanResult,
  stripInlineReasoning,
  validateAgentMessage,
} from "@/lib/agents/warehouse-agent";
import {
  GET_GANTRY_STATUS_TOOL_NAME,
  WAREHOUSE_AGENT_TOOLS,
  WAREHOUSE_AGENT_TOOL_NAMES,
  getGantryStatusTool,
} from "@/lib/agents/tools";
import { WAREHOUSE_AGENT_PROMPT } from "@/lib/agents/warehouse-prompt";
import { DEFAULT_BEDROCK_MODEL_ID, getBedrockModelId } from "@/lib/agents/model";
import { getGantryController, resetGantryController } from "@/lib/gantry/factory";

/**
 * Local tests only — nothing here calls Bedrock. The live model check is a
 * separate, explicitly-run script (`npm run agent:smoke`).
 */

beforeEach(() => {
  resetGantryController();
});

describe("get_gantry_status tool", () => {
  it("returns the real controller status", async () => {
    const result = await getGantryStatusTool.invoke({});

    expect(result).toEqual({
      mode: "SIMULATION",
      state: "IDLE",
      currentLocation: null,
      homed: false,
      activeOperationId: null,
      lastError: null,
    });
  });

  it("reflects genuine state changes rather than a fixed reading", async () => {
    const controller = getGantryController();
    await controller.home();
    await controller.putaway({ source: "INTAKE", destination: "B03" });

    const result = (await getGantryStatusTool.invoke({})) as {
      homed: boolean;
      currentLocation: string | null;
    };
    expect(result.homed).toBe(true);
    expect(result.currentLocation).toBe("B03");
  });

  it("is read-only — it creates no gantry operations", async () => {
    const controller = getGantryController();

    await getGantryStatusTool.invoke({});
    await getGantryStatusTool.invoke({});
    await getGantryStatusTool.invoke({});

    expect(await controller.getRecentOperations()).toEqual([]);
    const status = await controller.getStatus();
    expect(status.state).toBe("IDLE");
    expect(status.activeOperationId).toBeNull();
    expect(status.currentLocation).toBeNull();
  });

  it("declares an explicit schema and a read-only description", () => {
    expect(getGantryStatusTool.name).toBe("get_gantry_status");
    expect(getGantryStatusTool.description).toMatch(/read-only/i);

    const spec = getGantryStatusTool.toolSpec;
    expect(spec.name).toBe("get_gantry_status");
    expect(spec.inputSchema).toBeDefined();
    expect(JSON.stringify(spec.inputSchema)).toContain("object");
  });
});

describe("tool allowlist", () => {
  it("registers exactly the approved read-only tools, M5's included", () => {
    // The exact Milestone 6 list is asserted in warehouse-tools.test.ts; what
    // matters here is that the agent gets that list and nothing else, and that
    // the Milestone 5 tool survived the expansion.
    expect(WAREHOUSE_AGENT_TOOLS).toHaveLength(WAREHOUSE_AGENT_TOOL_NAMES.length);
    expect([...WAREHOUSE_AGENT_TOOL_NAMES]).toContain(GET_GANTRY_STATUS_TOOL_NAME);
  });

  it("exposes no mutating warehouse capability to the agent", () => {
    const agent = createWarehouseAgent();
    const names = agent.tools.map((t) => t.name);

    expect(names).toEqual([...WAREHOUSE_AGENT_TOOL_NAMES]);

    // match_catalog is deliberately absent from this list from M6 on: it is a
    // read-only call into the deterministic matcher and records nothing.
    const forbidden = [
      "home", "putaway", "retrieve", "move",
      "gantry_home", "gantry_putaway", "gantry_retrieve", "gantry_move",
      "add_inventory", "remove_inventory", "update_inventory",
      "create_part", "register_part", "delete_part",
      "create_movement", "complete_movement",
      "reserve_bin", "assign_bin", "scan",
    ];
    for (const name of forbidden) {
      expect(names, `agent must not expose "${name}"`).not.toContain(name);
    }
  });

  it("exposes no generic dangerous tool", () => {
    const names = createWarehouseAgent().tools.map((t) => t.name.toLowerCase());
    const dangerous = [
      "bash", "shell", "http_request", "file_editor", "fileeditor",
      "filesystem", "python", "code_interpreter", "browser", "sleep", "notebook",
    ];
    for (const name of dangerous) {
      expect(names, `agent must not expose "${name}"`).not.toContain(name);
    }
  });
});

describe("agent construction", () => {
  it("builds a single named agent with the approved tools and no console printing", () => {
    const agent = createWarehouseAgent();

    expect(agent).toBeInstanceOf(Agent);
    expect(agent.name).toBe(WAREHOUSE_AGENT_NAME);
    expect(agent.name).toBe("warehouse-agent");
    expect(agent.tools).toHaveLength(WAREHOUSE_AGENT_TOOL_NAMES.length);
  });

  it("is stateless — each call yields a fresh agent with empty history", () => {
    const first = createWarehouseAgent();
    const second = createWarehouseAgent();

    expect(first).not.toBe(second);
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([]);
  });

  it("pins an explicit Bedrock model id", () => {
    expect(getBedrockModelId()).toBe(DEFAULT_BEDROCK_MODEL_ID);
    expect(DEFAULT_BEDROCK_MODEL_ID).toMatch(/anthropic/);
  });

  it("constructs without any AWS credential being present", () => {
    // Credentials resolve lazily at request time, so construction must not
    // depend on them — this is what keeps the local suite runnable offline.
    expect(() => createWarehouseAgent()).not.toThrow();
  });
});

describe("system prompt", () => {
  it("carries the safety rules the agent depends on", () => {
    for (const clause of [
      "Never invent",
      "inventory quantities",
      "part identities",
      "bin locations",
      "gantry state",
      "scan results",
      "movement completion",
      "read-only",
      "not available yet",
      "motor-level",
      "ScanResult",
    ]) {
      expect(WAREHOUSE_AGENT_PROMPT, `prompt must mention "${clause}"`).toContain(clause);
    }
  });

  it("never claims an action succeeded without a tool saying so", () => {
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(
      /Never claim that a physical or simulated warehouse action was executed/,
    );
  });
});

describe("message validation", () => {
  it("accepts and trims a normal message", () => {
    expect(validateAgentMessage("  What is the gantry status?  ")).toBe(
      "What is the gantry status?",
    );
  });

  it("rejects a missing message", () => {
    expect(() => validateAgentMessage(undefined)).toThrow(AgentError);
    try {
      validateAgentMessage(undefined);
    } catch (err) {
      expect((err as AgentError).code).toBe("agent_invalid_request");
      expect((err as AgentError).status).toBe(422);
      expect((err as AgentError).issues).toContain("message must be a string");
    }
  });

  it("rejects an empty or whitespace-only message", () => {
    for (const value of ["", "   ", "\n\t"]) {
      try {
        validateAgentMessage(value);
        throw new Error(`expected "${value}" to be rejected`);
      } catch (err) {
        expect(isAgentError(err)).toBe(true);
        expect((err as AgentError).issues).toContain("message must not be empty");
      }
    }
  });

  it("rejects a non-string message", () => {
    for (const value of [42, true, null, {}, [], { message: "nested" }]) {
      expect(() => validateAgentMessage(value)).toThrow(AgentError);
    }
  });

  it("rejects an oversized message", () => {
    const tooLong = "a".repeat(MAX_AGENT_MESSAGE_LENGTH + 1);
    try {
      validateAgentMessage(tooLong);
      throw new Error("expected oversized message to be rejected");
    } catch (err) {
      expect((err as AgentError).issues[0]).toContain("at most 4000 characters");
    }
    // The boundary itself is allowed.
    expect(validateAgentMessage("a".repeat(MAX_AGENT_MESSAGE_LENGTH))).toHaveLength(
      MAX_AGENT_MESSAGE_LENGTH,
    );
  });

  it("rejects invalid input before any model call is attempted", async () => {
    // If validation leaked through, this would try to reach Bedrock and fail
    // with a different code.
    await expect(invokeWarehouseAgent("")).rejects.toMatchObject({
      code: "agent_invalid_request",
    });
  });
});

describe("error sanitization", () => {
  it("classifies missing credentials as model-unavailable with safe wording", () => {
    const aws = new Error(
      "Could not load credentials from any providers: AKIAIOSFODNN7EXAMPLE / arn:aws:iam::123456789012:role/secret-role",
    );
    aws.name = "CredentialsProviderError";

    const classified = classifyAgentFailure(aws);
    expect(classified.code).toBe("agent_model_unavailable");
    expect(classified.status).toBe(503);
    expect(classified.message).toBe(
      "The Warehouse Agent could not reach its Bedrock model. Check AWS credentials, region, and Bedrock model access.",
    );
  });

  it("classifies denied Bedrock model access as model-unavailable", () => {
    const denied = new Error("User is not authorized to perform: bedrock:InvokeModel");
    denied.name = "AccessDeniedException";
    expect(classifyAgentFailure(denied).code).toBe("agent_model_unavailable");
  });

  it("classifies an AccessDeniedException wrapped in a Strands ModelError", () => {
    // Strands surfaces SDK exceptions this way: the outer error carries none of
    // the markers, so classifying without walking `cause` mislabels it a 500.
    const cause = new Error("User is not authorized to perform: bedrock:InvokeModel");
    cause.name = "AccessDeniedException";
    const wrapped = new Error("Model invocation failed");
    wrapped.name = "ModelError";
    wrapped.cause = cause;

    expect(classifyAgentFailure(wrapped).code).toBe("agent_model_unavailable");
  });

  it("classifies an unbillable account as model-unavailable, not an invocation failure", () => {
    const denied = new Error(
      "Model access is denied due to INVALID_PAYMENT_INSTRUMENT:A valid payment instrument must be provided.. Your AWS Marketplace subscription for this model cannot be completed at this time.",
    );
    denied.name = "ModelError";

    const classified = classifyAgentFailure(denied);
    expect(classified.code).toBe("agent_model_unavailable");
    expect(classified.status).toBe(503);
  });

  it("survives a self-referential cause chain", () => {
    const a = new Error("outer");
    const b = new Error("inner");
    a.cause = b;
    b.cause = a;

    expect(classifyAgentFailure(a).code).toBe("agent_invocation_failed");
  });

  it("distinguishes a tool failure from a model failure", () => {
    const toolFailure = new AgentError("tool_execution_failed");
    expect(classifyAgentFailure(toolFailure).code).toBe("tool_execution_failed");
    expect(toolFailure.status).toBe(500);
  });

  it("falls back to invocation_failed for an unrecognized error", () => {
    expect(classifyAgentFailure(new Error("something odd happened")).code).toBe(
      "agent_invocation_failed",
    );
  });

  it("never leaks secrets, ARNs or stack traces in the response body", () => {
    const leaky = new Error(
      "AccessDenied for arn:aws:iam::123456789012:user/bob with key AKIAIOSFODNN7EXAMPLE and token FQoGZXIvYXdzEBYaDA",
    );
    leaky.name = "AccessDeniedException";

    const body = JSON.stringify(classifyAgentFailure(leaky).toResponseBody());

    for (const secret of [
      "AKIAIOSFODNN7EXAMPLE",
      "arn:aws:iam",
      "123456789012",
      "FQoGZXIvYXdzEBYaDA",
      "bob",
    ]) {
      expect(body, `response must not contain "${secret}"`).not.toContain(secret);
    }
    expect(body).not.toContain("at Object.");
    expect(body).not.toContain("stack");
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "agent_model_unavailable",
        message:
          "The Warehouse Agent could not reach its Bedrock model. Check AWS credentials, region, and Bedrock model access.",
      },
    });
  });

  it("keeps validation issues (which contain no secrets) but nothing else", () => {
    const body = new AgentError("agent_invalid_request", ["message must not be empty"]).toResponseBody();
    expect(body.error.issues).toEqual(["message must not be empty"]);
    expect(body.error.message).toBe("The request body was not a valid agent message.");
  });
});

describe("chain-of-thought suppression", () => {
  // Filtering reasoningBlock is not enough: Amazon Nova emits its scratchpad
  // inline in the text block. This was observed leaking verbatim in a live run.
  it("strips a paired <thinking> block but keeps the answer", () => {
    const raw =
      "<thinking>The tool only returned gantry status, not inventory.</thinking>\n\nI cannot check inventory quantities.";
    const out = stripInlineReasoning(raw);

    expect(out).toBe("I cannot check inventory quantities.");
    expect(out).not.toContain("thinking");
  });

  it("drops an unclosed opener, since the tail is all reasoning", () => {
    const raw = "Here is the status.\n<thinking>Now let me consider whether the bin";
    expect(stripInlineReasoning(raw)).toBe("Here is the status.");
  });

  it("handles tag attributes, casing and repeats", () => {
    const raw =
      '<Thinking priority="high">a</Thinking>visible one<SCRATCHPAD>b</SCRATCHPAD>\nvisible two';
    const out = stripInlineReasoning(raw);

    expect(out).toContain("visible one");
    expect(out).toContain("visible two");
    for (const leaked of ["a<", "Thinking", "SCRATCHPAD"]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("leaves ordinary prose alone, including the word thinking", () => {
    const raw = "I was thinking the gantry is idle. 3 < 5 and 7 > 2.";
    expect(stripInlineReasoning(raw)).toBe(raw);
  });

  it("returns empty string when the reply was nothing but reasoning", () => {
    expect(stripInlineReasoning("<thinking>all of it</thinking>")).toBe("");
  });

  it("unwraps a <response> envelope instead of showing the tags", () => {
    // Nova wrapped a live answer this way; the tags reached the API response.
    expect(stripInlineReasoning("<response>The gantry is idle.</response>")).toBe(
      "The gantry is idle.",
    );
    expect(stripInlineReasoning("<thinking>x</thinking><response>Bin B03 holds 2.</response>")).toBe(
      "Bin B03 holds 2.",
    );
  });

  it("keeps the tail when a <response> envelope was cut short", () => {
    expect(stripInlineReasoning("<response>Bin B03 holds 2 units of")).toBe(
      "Bin B03 holds 2 units of",
    );
  });

  it("leaves an answer that merely mentions a response alone", () => {
    const raw = "The tool response shows 3 units in stock.";
    expect(stripInlineReasoning(raw)).toBe(raw);
  });
});

describe("empty-reply fallback", () => {
  it("never promises data the agent cannot fetch", () => {
    // A live Nova run returned a reply that was 100% <thinking>; stripping it
    // left an empty bubble. The replacement must not fabricate an answer.
    expect(EMPTY_REPLY_FALLBACK.length).toBeGreaterThan(0);
    expect(EMPTY_REPLY_FALLBACK).toMatch(/gantry status/i);
    expect(EMPTY_REPLY_FALLBACK).not.toMatch(/\d+ (units|in stock)/i);
  });

  it("is what remains once a reasoning-only reply is stripped", () => {
    expect(stripInlineReasoning("<thinking>only reasoning</thinking>") || EMPTY_REPLY_FALLBACK).toBe(
      EMPTY_REPLY_FALLBACK,
    );
  });
});

describe("client-supplied ScanResult", () => {
  const validScan = {
    scanId: "scan_1788574200123_x8f21a",
    capturedAt: 1788574200123,
    object: { detectedName: "6204 bearing", description: "Metal circular bearing." },
    dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
    quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.7 },
    orientation: { angleDegrees: 12.4 },
  };

  it("accepts a well-formed scan and treats absence as legitimate", () => {
    expect(validateAgentScanResult(validScan)).toEqual(validScan);
    expect(validateAgentScanResult(undefined)).toBeNull();
    expect(validateAgentScanResult(null)).toBeNull();
  });

  it("rejects a malformed scan rather than silently dropping it", () => {
    // Dropping it would leave the agent answering as though no scan existed,
    // which reads to the operator as "no match" rather than "bad input".
    for (const bad of [
      {},
      "not an object",
      { ...validScan, dimensions: { lengthMM: -1, widthMM: 46.9, heightMM: null } },
      { ...validScan, quality: { dimensionConfidence: 5, calibrationRmsPixels: 1.7 } },
      { ...validScan, scanId: "" },
    ]) {
      expect(() => validateAgentScanResult(bad)).toThrow(AgentError);
    }
  });

  it("labels every issue as coming from scanResult, not the message", () => {
    try {
      validateAgentScanResult({});
      throw new Error("expected a rejection");
    } catch (err) {
      expect(isAgentError(err)).toBe(true);
      if (!isAgentError(err)) return;
      expect(err.code).toBe("agent_invalid_request");
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues.every((issue) => issue.startsWith("scanResult:"))).toBe(true);
    }
  });

  it("tells the agent an identity was confirmed, without quoting catalog text", () => {
    // Without this the agent re-runs match_catalog, sees AMBIGUOUS and asks the
    // operator to identify a part they have already identified.
    expect(IDENTITY_RESOLVED_NOTICE).toMatch(/execute_putaway/);
    expect(IDENTITY_RESOLVED_NOTICE).toMatch(/do not ask them to identify it again/i);
    expect(IDENTITY_RESOLVED_NOTICE).not.toMatch(/BOLT|BRG|bearing|bolt/);
  });

  it("announces an attached scan without quoting any scan-derived text", () => {
    // The notice is a server-authored constant. If scan text could reach the
    // model through it, a hostile label would become instruction-shaped.
    expect(SCAN_ATTACHED_NOTICE).toMatch(/match_catalog/);
    expect(SCAN_ATTACHED_NOTICE).not.toMatch(/6204|bearing|detectedName/i);
  });

  it("keeps scan text out of the system prompt entirely", () => {
    expect(WAREHOUSE_AGENT_PROMPT).not.toMatch(/6204/);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/never instructions to you/i);
  });
});

describe("system prompt, write rules", () => {
  it("separates asking where a part could go from storing it", () => {
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/only when the operator explicitly asks/i);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/never call either to answer an informational question/i);
    // A scan existing is not a request to store anything.
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/not, by itself, a request to store/i);
  });

  it("forbids claiming success the tool did not report", () => {
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(
      /never claim a putaway or retrieval succeeded unless the tool returned success/i,
    );
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/never state or infer an inventory quantity yourself/i);
  });

  it("names both write capabilities and keeps them behind explicit intent", () => {
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(
      /exactly two state-changing capabilities: execute_putaway.*execute_retrieval/i,
    );
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/only when the operator explicitly asks to bring/i);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/never invent an SKU/i);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/one item at a time/i);
    // A live run retrieved 1 of 3 requested. Partial fulfilment is a physical
    // action nobody asked for, so the instruction has to be unmissable.
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/do NOT call execute_retrieval at all/);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/do not chain state-changing actions/i);
    // A live run answered "remove one from inventory" with a physical gantry
    // retrieval. A stock correction is not a reason to move a part.
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/do NOT perform a retrieval instead/);
    // A live denial produced "Please approve the retrieval" — asking again for
    // something the operator had just refused.
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/means the OPERATOR said no/);
    expect(WAREHOUSE_AGENT_PROMPT).toMatch(/never ask them to approve it/i);
  });

  it("still rules out every direct mutation", () => {
    for (const clause of [
      "create or delete a catalog Part",
      "add, remove or otherwise modify inventory directly",
      "reserve or allocate a bin directly",
      "create or complete a warehouse Movement directly",
      "move, home or otherwise command the gantry directly",
      "retrieve more than one item in a single operation",
    ]) {
      expect(WAREHOUSE_AGENT_PROMPT, `prompt must still forbid "${clause}"`).toContain(clause);
    }
  });
});
