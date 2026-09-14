/**
 * Centralised model configuration for the Warehouse Agent.
 *
 * TWO SEPARATE MODEL RESPONSIBILITIES, deliberately not merged:
 *  - Gemini (lib/geminiMeasure.ts, GEMINI_API_KEY) does vision — it localizes
 *    and names the scanned object. Untouched by this module.
 *  - Bedrock through Strands does warehouse reasoning and tool selection.
 * GEMINI_API_KEY is never read here, and no image ever reaches this model.
 *
 * CREDENTIALS: resolved entirely by the standard AWS chain (environment,
 * shared config/credentials file, SSO, IAM role). Nothing here reads or
 * stores an access key, secret, session token or bearer token, and none may
 * be committed — put them in the AWS chain, or in .env.local, which git
 * ignores.
 */
import { BedrockModel } from "@strands-agents/sdk";

/**
 * Pinned rather than left to the SDK default, which is documented as subject
 * to change between versions (and logs a warning when relied on).
 *
 * The `us.` prefix is required, not cosmetic: Bedrock lists Nova as
 * INFERENCE_PROFILE-only, so the bare `amazon.nova-lite-v1:0` id is rejected
 * for on-demand invocation. The `:0` version suffix is part of the id — an id
 * without it does not resolve.
 *
 * Nova rather than `global.anthropic.claude-sonnet-5` because this account's
 * AWS Marketplace subscription for Anthropic models is blocked
 * (INVALID_PAYMENT_INSTRUMENT); Amazon's own models are not
 * Marketplace-transacted. Switching back is this line, or BEDROCK_MODEL_ID.
 */
export const DEFAULT_BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";

/** Low but not zero: tool selection should be near-deterministic. */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1024;

export function getBedrockModelId(): string {
  return process.env.BEDROCK_MODEL_ID?.trim() || DEFAULT_BEDROCK_MODEL_ID;
}

/** Standard AWS resolution order; undefined lets the SDK/AWS chain decide. */
export function getAwsRegion(): string | undefined {
  return process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || undefined;
}

export function createWarehouseModel(): BedrockModel {
  const region = getAwsRegion();
  return new BedrockModel({
    modelId: getBedrockModelId(),
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...(region ? { region } : {}),
  });
}
