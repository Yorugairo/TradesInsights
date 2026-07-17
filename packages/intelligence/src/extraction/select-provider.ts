import { AnthropicProvider } from "./anthropic.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { ModelProvider } from "./provider.js";

/**
 * Single place that turns env into a concrete provider, so extract:run,
 * verify:run, and any future model job resolve the provider identically.
 *
 * Selection order (first configured key wins):
 *   1. OPENROUTER_API_KEY → OpenRouterProvider (requires OPENROUTER_MODEL)
 *   2. ANTHROPIC_API_KEY  → AnthropicProvider
 * No key configured → null, i.e. the visible blocked state (spec §3). This
 * function never fabricates a key or a model.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider | null {
  if (env.OPENROUTER_API_KEY) {
    return new OpenRouterProvider({
      apiKey: env.OPENROUTER_API_KEY,
      ...(env.OPENROUTER_MODEL ? { model: env.OPENROUTER_MODEL } : {}),
      ...(env.OPENROUTER_REFERER ? { referer: env.OPENROUTER_REFERER } : {}),
      ...(env.OPENROUTER_TITLE ? { title: env.OPENROUTER_TITLE } : {}),
    });
  }
  if (env.ANTHROPIC_API_KEY) return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY });
  return null;
}

/** Which provider providerFromEnv would pick, without constructing it. */
export function configuredProviderName(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}
