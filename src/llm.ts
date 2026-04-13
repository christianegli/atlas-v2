/**
 * LLM provider — auto-detects proxy vs direct Anthropic API.
 *
 * Priority:
 *   1. If PROXY_BASE_URL is set → use OpenAI-compatible proxy
 *      (any local proxy, Claude Code proxy, etc.)
 *   2. Otherwise → use direct Anthropic API with ANTHROPIC_API_KEY
 *
 * This allows Atlas to run in any environment without code changes.
 */

import {
  streamSimpleOpenAICompletions,
  streamSimpleAnthropic,
  getModel,
} from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

const PROXY_BASE_URL = process.env.PROXY_BASE_URL;
const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "sk-proxy-local-dummy";
const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

export type ProviderMode = "proxy" | "anthropic";

/**
 * Which mode Atlas is running in.
 * Set at startup based on environment variables.
 */
export const PROVIDER_MODE: ProviderMode = PROXY_BASE_URL ? "proxy" : "anthropic";

// ─── Proxy mode ────────────────────────────────────────────────────────────

const proxyModel: Model<"openai-completions"> = {
  id: MODEL_ID,
  name: `${MODEL_ID} (proxy)`,
  api: "openai-completions",
  provider: "openai",
  baseUrl: PROXY_BASE_URL ?? "http://localhost:8642/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const proxyStreamFn = (
  m: Model<"openai-completions">,
  ctx: Parameters<typeof streamSimpleOpenAICompletions>[1],
  opts?: Parameters<typeof streamSimpleOpenAICompletions>[2]
) =>
  streamSimpleOpenAICompletions(m, ctx, {
    ...opts,
    apiKey: PROXY_API_KEY,
  });

// ─── Anthropic direct mode ─────────────────────────────────────────────────

// We rely on ANTHROPIC_API_KEY being in the environment — getModel() handles registration.
const anthropicModel = getModel("anthropic", "claude-sonnet-4-6");

const anthropicStreamFn = (
  m: typeof anthropicModel,
  ctx: Parameters<typeof streamSimpleAnthropic>[1],
  opts?: Parameters<typeof streamSimpleAnthropic>[2]
) =>
  streamSimpleAnthropic(m, ctx, {
    ...opts,
    apiKey: ANTHROPIC_API_KEY,
  });

// ─── Exports ────────────────────────────────────────────────────────────────

/**
 * The model to use for the conscious (main agent) loop.
 * Use this in agent.ts and any direct LLM calls.
 */
export const consciousModel: Model<any> =
  PROVIDER_MODE === "proxy" ? proxyModel : anthropicModel;

/**
 * The stream function paired with consciousModel.
 * Cast to StreamFn for use with pi-agent-core's Agent.
 */
export const consciousStreamFn: StreamFn =
  PROVIDER_MODE === "proxy"
    ? (proxyStreamFn as unknown as StreamFn)
    : (anthropicStreamFn as unknown as StreamFn);
