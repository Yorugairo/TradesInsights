/**
 * M0.5 — durable jobs: pg-boss retry then dead-letter, and the visible
 * blocked state for model-dependent jobs when no key is configured.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { modelAvailability } from "../src/env.js";

const TEST_QUEUE = "test-failing-job";
const TEST_DLQ = "test-failing-job-dlq";

let boss: PgBoss;

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
  await boss.start();
  await boss.createQueue(TEST_DLQ);
  await boss.createQueue(TEST_QUEUE, {
    name: TEST_QUEUE,
    retryLimit: 1,
    retryDelay: 1,
    deadLetter: TEST_DLQ,
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

describe("durable jobs", () => {
  it("retries a failing job and dead-letters it with the payload intact", async () => {
    let attempts = 0;
    await boss.work(TEST_QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
      attempts++;
      throw new Error("boom");
    });

    await boss.send(TEST_QUEUE, { sourceKey: "does_not_exist" });

    const deadline = Date.now() + 20_000;
    let dead: { data: unknown }[] = [];
    while (Date.now() < deadline) {
      dead = (await boss.fetch(TEST_DLQ)) ?? [];
      if (dead.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(attempts).toBe(2); // original + 1 retry
    expect(dead).toHaveLength(1);
    expect(dead[0]!.data).toEqual({ sourceKey: "does_not_exist" });
  });
});

describe("model availability gate", () => {
  it("reports a visible blocked state without model keys", () => {
    const saved = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = modelAvailability();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("blocked");
    if (saved.anthropic) process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.openai) process.env.OPENAI_API_KEY = saved.openai;
  });

  it("requires a budget even when a key exists", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    const result = modelAvailability();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("budget");
    delete process.env.ANTHROPIC_API_KEY;
  });
});
