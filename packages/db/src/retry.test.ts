import { describe, expect, it, vi } from "vitest";
import { isTransientConnectionError, withConnectionRetry } from "./retry.js";

/** No real sleeping — the backoff is asserted by inspecting the delays. */
function fakeSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("isTransientConnectionError", () => {
  it("recognises the message pg gives when the pooler reaps a socket", () => {
    expect(isTransientConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("recognises libuv codes even when the message says nothing useful", () => {
    const e = Object.assign(new Error(""), { code: "ECONNRESET" });
    expect(isTransientConnectionError(e)).toBe(true);
  });

  /**
   * The shape that actually broke thurston_active_notices on 2026-07-27: a
   * DrizzleQueryError whose OWN message is the SQL text, with the real signal an
   * AggregateError two levels down in `cause`. Matching only the top-level
   * message classified a connection fault as a query failure, and the source was
   * recorded as failed after it had parsed its record cleanly.
   */
  it("unwraps a cause chain ending in an AggregateError (the real 2026-07-27 shape)", () => {
    const inner = Object.assign(new Error(""), { code: "ETIMEDOUT" });
    const aggregate = new AggregateError([inner], "");
    const drizzle = Object.assign(
      new Error('Failed query: update "source_runs" set "completed_at" = $1'),
      { cause: aggregate },
    );
    expect(isTransientConnectionError(drizzle)).toBe(true);
  });

  it("recognises the DNS failure that killed six scraper workers at once", () => {
    const e = Object.assign(
      new Error("getaddrinfo ENOTFOUND aws-1-us-west-2.pooler.supabase.com"),
      { code: "ENOTFOUND" },
    );
    expect(isTransientConnectionError(e)).toBe(true);
  });

  it("recognises server-side termination SQLSTATEs", () => {
    expect(isTransientConnectionError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
  });

  it("does NOT treat a constraint violation as transient", () => {
    const e = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: "23505",
    });
    expect(isTransientConnectionError(e)).toBe(false);
  });

  it("does not blow up on null, strings, or cyclic causes", () => {
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError("ECONNRESET")).toBe(true);
    const a: { cause?: unknown; message: string } = { message: "nope" };
    a.cause = a; // cyclic — depth cap must stop the walk
    expect(isTransientConnectionError(a)).toBe(false);
  });
});

describe("withConnectionRetry", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;
    const result = await withConnectionRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("Connection terminated unexpectedly");
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1000]); // exponential, one per retry
  });

  it("rethrows a non-transient error IMMEDIATELY, without burning backoffs", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withConnectionRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        },
        { sleep },
      ),
    ).rejects.toThrow("duplicate key");
    // A fast failure must stay fast: one attempt, zero sleeps.
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("gives up after maxAttempts rather than hanging forever", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withConnectionRetry(
        async () => {
          calls++;
          throw new Error("Connection terminated unexpectedly");
        },
        { sleep, maxAttempts: 4 },
      ),
    ).rejects.toThrow("Connection terminated");
    expect(calls).toBe(4);
    expect(delays).toHaveLength(3);
  });

  it("reports every retry so a degraded link is visible, not silent", async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    let calls = 0;
    await withConnectionRetry(
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error(""), { code: "ETIMEDOUT" });
        return 1;
      },
      { sleep, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
  });

  it("does not call the callback again when the first attempt succeeds", async () => {
    const { delays, sleep } = fakeSleep();
    const fn = vi.fn(async () => "first");
    expect(await withConnectionRetry(fn, { sleep })).toBe("first");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
