import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { ModelProvider, ModelRequest, ModelResponse } from "./provider.js";

/**
 * OpenRouter provider (spec §13). OpenRouter exposes an OpenAI-compatible
 * Chat Completions API and routes to many underlying models; we talk to it
 * with raw fetch (no SDK) so the request headers, proxy dispatcher, and — most
 * importantly — the cost accounting stay under our control.
 *
 * Key-activated: constructed only when OPENROUTER_API_KEY is present, so a
 * keyless deployment keeps the pipeline in its visible blocked state (spec §3)
 * rather than failing.
 *
 * Honest cost (the §13 requirement): we cannot hardcode a pricing table for
 * arbitrary OpenRouter models, so we ask OpenRouter for the authoritative
 * charged amount via `usage: { include: true }` and store `usage.cost`
 * verbatim. If a response ever omits it, we fall back to a deliberately
 * conservative Opus-tier estimate ($5/$25 per MTok) and flag it — the ledger
 * must never *under*-count spend, so a missing cost is rounded up, not to zero.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Conservative fallback pricing (USD per MTok) if OpenRouter omits usage.cost. */
const FALLBACK_PRICING = { input: 5, output: 25 };

// Node's built-in fetch ignores HTTPS_PROXY (see source-sdk/fetch-policy.ts);
// route through undici's env-var proxy agent in proxied environments.
let envProxyAgent: Dispatcher | undefined;
function proxiedFetch(): typeof undiciFetch {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return undiciFetch;
  envProxyAgent ??= new EnvHttpProxyAgent();
  const dispatcher = envProxyAgent;
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher })) as typeof undiciFetch;
}

interface OpenRouterChoice {
  message?: { content?: string | null };
}
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Present when the request sets usage.include = true; USD charged. */
  cost?: number;
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: { message?: string };
}

export interface OpenRouterOptions {
  apiKey?: string;
  /** OpenRouter model slug, e.g. "anthropic/claude-opus-4.1". Required — no
   * default is fabricated, since guessing a slug could silently route to the
   * wrong model. Set OPENROUTER_MODEL or pass this explicitly. */
  model?: string;
  /** Optional attribution headers OpenRouter uses for rankings (non-critical). */
  referer?: string;
  title?: string;
  /** Injectable for tests; defaults to the (optionally proxied) undici fetch. */
  fetchImpl?: typeof undiciFetch;
  onCostFallback?: (info: { model: string }) => void;
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;
  private readonly fetchImpl: typeof undiciFetch;
  private readonly onCostFallback: ((info: { model: string }) => void) | undefined;

  constructor(opts: OpenRouterOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set — model jobs must stay blocked without it");
    }
    const model = opts.model ?? process.env.OPENROUTER_MODEL;
    if (!model) {
      throw new Error(
        "OPENROUTER_MODEL is not set — set it to an OpenRouter model slug " +
          '(e.g. "anthropic/claude-opus-4.1"); no default is guessed',
      );
    }
    this.apiKey = apiKey;
    this.model = model;
    this.referer = opts.referer ?? process.env.OPENROUTER_REFERER;
    this.title = opts.title ?? process.env.OPENROUTER_TITLE ?? "OTN Insights";
    this.fetchImpl = opts.fetchImpl ?? proxiedFetch();
    this.onCostFallback = opts.onCostFallback;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": this.title ?? "OTN Insights",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;

    const res = await this.fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        // usage.include asks OpenRouter to return the authoritative charged cost.
        usage: { include: true },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText} ${body}`.trim());
    }

    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message ?? "unknown"}`);
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    let costUsd: number;
    if (typeof data.usage?.cost === "number") {
      costUsd = data.usage.cost; // authoritative
    } else {
      // Never under-count: round a missing cost up at Opus-tier pricing.
      costUsd = (inputTokens * FALLBACK_PRICING.input + outputTokens * FALLBACK_PRICING.output) / 1_000_000;
      this.onCostFallback?.({ model: this.model });
    }

    return { text, inputTokens, outputTokens, costUsd };
  }
}
