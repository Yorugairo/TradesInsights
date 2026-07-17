import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "./openrouter.js";
import { providerFromEnv, configuredProviderName } from "./select-provider.js";

/** Minimal fake of an undici Response carrying a canned OpenRouter body. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

const OK_BODY = {
  choices: [{ message: { content: '{"facts":[]}' } }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0123 },
};

describe("OpenRouterProvider", () => {
  it("requires a key and a model — no fabricated defaults", () => {
    // Hermetic: the constructor falls back to process.env, and a real
    // OPENROUTER_API_KEY/MODEL may be injected into the run environment.
    const saved = { key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    try {
      expect(() => new OpenRouterProvider({ model: "anthropic/claude-opus-4.1" })).toThrow(
        /OPENROUTER_API_KEY is not set/,
      );
      expect(() => new OpenRouterProvider({ apiKey: "sk-or-test" })).toThrow(
        /OPENROUTER_MODEL is not set/,
      );
    } finally {
      if (saved.key !== undefined) process.env.OPENROUTER_API_KEY = saved.key;
      if (saved.model !== undefined) process.env.OPENROUTER_MODEL = saved.model;
    }
  });

  it("returns text, token usage, and OpenRouter's authoritative cost", async () => {
    const fetchImpl = fakeFetch(OK_BODY);
    const provider = new OpenRouterProvider({
      apiKey: "sk-or-test",
      model: "anthropic/claude-opus-4.1",
      fetchImpl: fetchImpl as never,
    });
    const res = await provider.complete({ system: "sys", prompt: "hello", maxTokens: 512 });

    expect(res.text).toBe('{"facts":[]}');
    expect(res.inputTokens).toBe(1200);
    expect(res.outputTokens).toBe(300);
    expect(res.costUsd).toBe(0.0123); // usage.cost verbatim, not recomputed

    // Request shape: usage.include on, system + user messages, model passed through.
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock
      .calls[0]!;
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("anthropic/claude-opus-4.1");
    expect(sent.usage).toEqual({ include: true });
    expect(sent.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("falls back to a conservative (never-zero) cost when usage.cost is absent", async () => {
    const onCostFallback = vi.fn();
    const provider = new OpenRouterProvider({
      apiKey: "sk-or-test",
      model: "some/model",
      fetchImpl: fakeFetch({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, // no cost field
      }) as never,
      onCostFallback,
    });
    const res = await provider.complete({ system: "s", prompt: "p" });
    // 1M input @ $5 + 1M output @ $25 = $30, rounded up rather than reported as 0.
    expect(res.costUsd).toBeCloseTo(30, 5);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(onCostFallback).toHaveBeenCalledOnce();
  });

  it("surfaces an HTTP error instead of returning empty text", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "sk-or-test",
      model: "some/model",
      fetchImpl: fakeFetch({ error: { message: "no credits" } }, { ok: false, status: 402 }) as never,
    });
    await expect(provider.complete({ system: "s", prompt: "p" })).rejects.toThrow(/402/);
  });

  it("surfaces a body-level error payload", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "sk-or-test",
      model: "some/model",
      fetchImpl: fakeFetch({ error: { message: "model not found" } }) as never,
    });
    await expect(provider.complete({ system: "s", prompt: "p" })).rejects.toThrow(/model not found/);
  });
});

describe("providerFromEnv", () => {
  it("prefers OpenRouter, then Anthropic, else null (blocked)", () => {
    expect(configuredProviderName({} as NodeJS.ProcessEnv)).toBeNull();
    expect(providerFromEnv({} as NodeJS.ProcessEnv)).toBeNull();

    expect(
      configuredProviderName({ ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv),
    ).toBe("anthropic");
    expect(
      configuredProviderName({
        OPENROUTER_API_KEY: "sk-or",
        OPENROUTER_MODEL: "anthropic/claude-opus-4.1",
        ANTHROPIC_API_KEY: "sk-ant",
      } as NodeJS.ProcessEnv),
    ).toBe("openrouter"); // OpenRouter wins when both keys present

    const p = providerFromEnv({
      OPENROUTER_API_KEY: "sk-or",
      OPENROUTER_MODEL: "anthropic/claude-opus-4.1",
    } as NodeJS.ProcessEnv);
    expect(p?.name).toBe("openrouter");
    expect(p?.model).toBe("anthropic/claude-opus-4.1");
  });
});
