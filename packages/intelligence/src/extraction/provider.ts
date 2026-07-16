/**
 * Model provider abstraction (spec §13). Providers do one thing: turn a
 * prompt into text plus honest usage/cost numbers. Everything contract-shaped
 * (validation, budgets, persistence) lives outside the provider so the mock
 * and the real provider exercise identical code paths.
 */

export interface ModelRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export interface MockResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Deterministic provider for tests and keyless local runs. Responses are
 * consumed in order; the last one repeats. Every request is captured for
 * assertions.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock-model";
  readonly calls: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly responses: MockResponse[]) {
    if (responses.length === 0) throw new Error("MockProvider needs at least one response");
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const r = this.responses[Math.min(this.cursor, this.responses.length - 1)]!;
    this.cursor++;
    return {
      text: r.text,
      inputTokens: r.inputTokens ?? 1000,
      outputTokens: r.outputTokens ?? 200,
      costUsd: r.costUsd ?? 0.01,
    };
  }
}
