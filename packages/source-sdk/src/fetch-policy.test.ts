import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchPolicy } from "./fetch-policy.js";
import { createLogger } from "./logging.js";

const logger = createLogger({ app: "fetch-policy-test" });

/** A stub Response good enough for the policy's own accessors. */
function ok(body = "<html></html>", setCookie: string[] = []) {
  return {
    ok: true,
    status: 200,
    headers: {
      forEach: (fn: (v: string, k: string) => void) => fn("text/html", "content-type"),
      getSetCookie: () => setCookie,
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchPolicy crawl delay", () => {
  it("spaces consecutive request STARTS by minIntervalMs", async () => {
    // Honouring a published `Crawl-delay` belongs here rather than in an
    // adapter: a per-adapter sleep is invisible to the object that owns
    // concurrency, so the two can silently disagree about how hard a host is
    // being hit.
    const starts: number[] = [];
    vi.stubGlobal("fetch", async () => {
      starts.push(Date.now());
      return ok();
    });

    const policy = new FetchPolicy({
      userAgent: "test",
      maxConcurrency: 1,
      minIntervalMs: 120,
    });
    await Promise.all([
      policy.fetch("https://example.test/a", logger),
      policy.fetch("https://example.test/b", logger),
      policy.fetch("https://example.test/c", logger),
    ]);

    expect(starts).toHaveLength(3);
    // Generous lower bound: this asserts the gate exists, not the timer's
    // precision, so it does not go flaky on a loaded machine.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
  });

  it("does not delay at all when minIntervalMs is unset", async () => {
    vi.stubGlobal("fetch", async () => ok());
    const policy = new FetchPolicy({ userAgent: "test" });
    const began = Date.now();
    await Promise.all([
      policy.fetch("https://example.test/a", logger),
      policy.fetch("https://example.test/b", logger),
    ]);
    expect(Date.now() - began).toBeLessThan(100);
  });
});

describe("FetchPolicy POST + cookies", () => {
  it("sends the method, body and caller headers", async () => {
    let seen: { url?: string; init?: Record<string, unknown> } = {};
    vi.stubGlobal("fetch", async (url: string, init: Record<string, unknown>) => {
      seen = { url, init };
      return ok();
    });

    const policy = new FetchPolicy({ userAgent: "test-agent" });
    await policy.fetch("https://example.test/form", logger, undefined, {
      method: "POST",
      body: "__EVENTTARGET=DataGrid1",
      headers: { cookie: "ASP.NET_SessionId=abc", "content-type": "application/x-www-form-urlencoded" },
    });

    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe("__EVENTTARGET=DataGrid1");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("ASP.NET_SessionId=abc");
    // The policy's own user agent survives the caller's header merge.
    expect(headers["user-agent"]).toBe("test-agent");
  });

  it("exposes Set-Cookie on the response but keeps it out of the persisted headers", async () => {
    // `headers` is written to raw_artifacts. A session token must never land
    // there — but WEBS cannot page without one, so it is surfaced separately.
    vi.stubGlobal("fetch", async () => ok("<html></html>", ["ASP.NET_SessionId=xyz; path=/; HttpOnly"]));
    const policy = new FetchPolicy({ userAgent: "test" });
    const res = await policy.fetch("https://example.test/", logger);

    expect(res.setCookie).toEqual(["ASP.NET_SessionId=xyz; path=/; HttpOnly"]);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
