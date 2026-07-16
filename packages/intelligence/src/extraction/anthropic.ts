import Anthropic from "@anthropic-ai/sdk";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

/**
 * Anthropic provider (spec §13). Key-activated: constructed only when
 * ANTHROPIC_API_KEY is present — callers without a key keep the pipeline in
 * the visible blocked state instead of failing. Cost is computed from the
 * response's actual token usage and the published per-MTok pricing so the
 * stored cost_usd rows are honest inputs to the monthly budget check.
 */

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/** USD per million tokens. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
};

// Node's built-in fetch ignores HTTPS_PROXY (see source-sdk/fetch-policy.ts);
// in proxied environments route the SDK through undici's env-var proxy agent.
let envProxyAgent: Dispatcher | undefined;
function proxiedFetch(): typeof globalThis.fetch | undefined {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return undefined;
  envProxyAgent ??= new EnvHttpProxyAgent();
  const dispatcher = envProxyAgent;
  return ((input: unknown, init?: object) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set — model jobs must stay blocked without it");
    }
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    const fetch = proxiedFetch();
    this.client = new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // Streaming avoids request timeouts on long evidence bundles; adaptive
    // thinking lets the model reason before committing to strict JSON.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: req.prompt }],
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const pricing = PRICING[this.model] ?? PRICING[DEFAULT_ANTHROPIC_MODEL]!;
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    return { text, inputTokens, outputTokens, costUsd };
  }
}
