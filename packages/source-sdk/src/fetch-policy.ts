import pLimit from "p-limit";
import type { Logger } from "pino";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { redactUrl } from "./logging.js";

// Node's global fetch does not honor HTTPS_PROXY/NO_PROXY on its own (curl
// does). In proxied environments (CI, Claude Code remote, corporate egress)
// route through the standard env-var proxy; TLS trust comes from
// NODE_EXTRA_CA_CERTS. undici's own fetch is used so the dispatcher and the
// fetch implementation always version-match.
let envProxyAgent: Dispatcher | undefined;
function proxyDispatcher(): Dispatcher | undefined {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return undefined;
  envProxyAgent ??= new EnvHttpProxyAgent();
  return envProxyAgent;
}

export type RetryClass = "retryable" | "fatal";

export class FetchError extends Error {
  constructor(
    message: string,
    readonly retryClass: RetryClass,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export function classifyHttpStatus(status: number): RetryClass {
  if (status === 429 || status >= 500) return "retryable";
  return "fatal";
}

export interface FetchPolicyOptions {
  userAgent: string;
  maxConcurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  /**
   * Minimum gap between the START of consecutive requests through this policy,
   * for a host that publishes a `Crawl-delay`.
   *
   * Lives here rather than in the adapter deliberately: a per-adapter `sleep()`
   * is invisible to the policy that owns concurrency, so the two can disagree
   * and the pacing silently stops applying. Enforcing it at the same choke
   * point as `maxConcurrency` means one place decides how hard a host is hit.
   *
   * Set it and `maxConcurrency: 1` together — spacing request starts is
   * meaningless if two are still in flight at once.
   */
  minIntervalMs?: number;
}

export interface PolicedResponse {
  body: Buffer;
  httpStatus: number;
  contentType: string;
  headers: Record<string, string>;
  /** True for a 304 conditional-request hit — body is empty and content unchanged. */
  notModified: boolean;
  /**
   * `Set-Cookie` values, exposed ONLY here. They are stripped from `headers`
   * (which is persisted onto `raw_artifacts`) so a session token never lands in
   * the database, but an ASP.NET form source cannot page without them: WEBS
   * returns page 1 forever if the postback arrives with a valid ViewState and
   * no `ASP.NET_SessionId`. Measured 2026-07-27 — with the cookie the same
   * request returns a page with zero overlap; without it, an identical page 1.
   */
  setCookie: string[];
}

/** A non-GET request through the policy (ASP.NET postbacks). */
export interface PolicedRequest {
  method: "GET" | "POST";
  body?: string;
  /** Merged over the policy's own headers. */
  headers?: Record<string, string>;
}

/**
 * Spec §5 fetch policy: bounded concurrency, explicit user agent, timeouts,
 * retry classification with exponential backoff, conditional requests.
 */
export class FetchPolicy {
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly opts: Required<FetchPolicyOptions>;
  /** Monotonic gate for `minIntervalMs`: when the next request may start. */
  private nextAllowedStart = 0;

  constructor(options: FetchPolicyOptions) {
    this.opts = {
      maxConcurrency: 2,
      timeoutMs: 30_000,
      maxRetries: 3,
      baseDelayMs: 1_000,
      minIntervalMs: 0,
      ...options,
    };
    this.limit = pLimit(this.opts.maxConcurrency);
  }

  async fetch(
    url: string,
    logger: Logger,
    conditional?: { etag?: string; lastModified?: string },
    request?: PolicedRequest,
  ): Promise<PolicedResponse> {
    return this.limit(async () => {
      await this.awaitCrawlDelay();
      return this.fetchWithRetry(url, logger, conditional, request);
    });
  }

  /**
   * Hold inside the concurrency slot so the gap is between request STARTS
   * regardless of how long each response takes. Reserving `nextAllowedStart`
   * before awaiting keeps it correct when several callers queue at once.
   */
  private async awaitCrawlDelay(): Promise<void> {
    if (this.opts.minIntervalMs <= 0) return;
    const now = Date.now();
    const startAt = Math.max(now, this.nextAllowedStart);
    this.nextAllowedStart = startAt + this.opts.minIntervalMs;
    if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));
  }

  private async fetchWithRetry(
    url: string,
    logger: Logger,
    conditional?: { etag?: string; lastModified?: string },
    request?: PolicedRequest,
  ): Promise<PolicedResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.opts.baseDelayMs * 2 ** (attempt - 1);
        logger.warn({ url: redactUrl(url), attempt, delay }, "retrying fetch");
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await this.fetchOnce(url, conditional, request);
      } catch (err) {
        lastError = err;
        if (err instanceof FetchError && err.retryClass === "fatal") throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new FetchError(`fetch failed: ${redactUrl(url)}`, "retryable");
  }

  private async fetchOnce(
    url: string,
    conditional?: { etag?: string; lastModified?: string },
    request?: PolicedRequest,
  ): Promise<PolicedResponse> {
    const headers: Record<string, string> = { "user-agent": this.opts.userAgent };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
    for (const [k, v] of Object.entries(request?.headers ?? {})) headers[k] = v;

    const method = request?.method ?? "GET";
    const init = {
      method,
      headers,
      ...(request?.body !== undefined ? { body: request.body } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const dispatcher = proxyDispatcher();
      const res = dispatcher
        ? await undiciFetch(url, { ...init, signal: controller.signal, dispatcher })
        : await fetch(url, { ...init, signal: controller.signal });
      const setCookie = res.headers.getSetCookie?.() ?? [];
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!["set-cookie", "authorization"].includes(k.toLowerCase())) {
          responseHeaders[k] = v;
        }
      });
      if (res.status === 304) {
        return {
          body: Buffer.alloc(0),
          httpStatus: 304,
          contentType: responseHeaders["content-type"] ?? "application/octet-stream",
          headers: responseHeaders,
          notModified: true,
          setCookie,
        };
      }
      if (!res.ok) {
        throw new FetchError(
          `HTTP ${res.status} for ${redactUrl(url)}`,
          classifyHttpStatus(res.status),
          res.status,
        );
      }
      const body = Buffer.from(await res.arrayBuffer());
      return {
        body,
        httpStatus: res.status,
        contentType: responseHeaders["content-type"] ?? "application/octet-stream",
        headers: responseHeaders,
        notModified: false,
        setCookie,
      };
    } catch (err) {
      if (err instanceof FetchError) throw err;
      // Timeouts and network errors are retryable.
      throw new FetchError(
        `network error for ${redactUrl(url)}: ${err instanceof Error ? err.message : String(err)}`,
        "retryable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
