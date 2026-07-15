import { describe, expect, it } from "vitest";
import { MemoryObjectStore, sha256Hex } from "./object-store.js";
import { classifyHttpStatus } from "./fetch-policy.js";
import { normalizedFingerprint } from "./runner.js";
import { redactUrl } from "./logging.js";

describe("MemoryObjectStore", () => {
  it("content-addresses by sha256 and reports idempotent reruns", async () => {
    const store = new MemoryObjectStore();
    const body = Buffer.from('{"a":1}');
    const first = await store.putImmutable("fake_source", body, "application/json");
    expect(first.alreadyExisted).toBe(false);
    expect(first.sha256).toBe(sha256Hex(body));
    expect(first.storageKey).toBe(`raw/fake_source/${first.sha256}`);

    const second = await store.putImmutable("fake_source", body, "application/json");
    expect(second.alreadyExisted).toBe(true);
    expect(second.storageKey).toBe(first.storageKey);
    expect(await store.get(first.storageKey)).toEqual(body);
  });

  it("different content gets a different key — nothing is ever overwritten", async () => {
    const store = new MemoryObjectStore();
    const a = await store.putImmutable("s", Buffer.from("v1"), "text/plain");
    const b = await store.putImmutable("s", Buffer.from("v2"), "text/plain");
    expect(a.storageKey).not.toBe(b.storageKey);
    expect((await store.get(a.storageKey)).toString()).toBe("v1");
  });
});

describe("retry classification", () => {
  it("marks 429 and 5xx retryable, 4xx fatal", () => {
    expect(classifyHttpStatus(429)).toBe("retryable");
    expect(classifyHttpStatus(500)).toBe("retryable");
    expect(classifyHttpStatus(503)).toBe("retryable");
    expect(classifyHttpStatus(404)).toBe("fatal");
    expect(classifyHttpStatus(403)).toBe("fatal");
  });
});

describe("normalizedFingerprint", () => {
  it("is stable across key order", () => {
    expect(normalizedFingerprint({ a: 1, b: "x" })).toBe(
      normalizedFingerprint({ b: "x", a: 1 }),
    );
  });
  it("changes when a value changes", () => {
    expect(normalizedFingerprint({ a: 1 })).not.toBe(normalizedFingerprint({ a: 2 }));
  });
});

describe("redactUrl", () => {
  it("redacts sensitive query params", () => {
    const out = redactUrl("https://x.gov/api?token=secret123&page=2");
    expect(out).not.toContain("secret123");
    expect(out).toContain("page=2");
  });
});
