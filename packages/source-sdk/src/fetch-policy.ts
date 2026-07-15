import pLimit from "p-limit";
import type { Logger } from "pino";
import { redactUrl } from "./logging.js";

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
}

export interface PolicedResponse {
  body: Buffer;
  httpStatus: number;
  contentType: string;
  headers: Record<string, string>;
  /** True for a 304 conditional-request hit — body is empty and content unchanged. */
  notModified: boolean;
}

/**
 * Spec §5 fetch policy: bounded concurrency, explicit user agent, timeouts,
 * retry classification with exponential backoff, conditional requests.
 */
export class FetchPolicy {
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly opts: Required<FetchPolicyOptions>;

  constructor(options: FetchPolicyOptions) {
    this.opts = {
      maxConcurrency: 2,
      timeoutMs: 30_000,
      maxRetries: 3,
      baseDelayMs: 1_000,
      ...options,
    };
    this.limit = pLimit(this.opts.maxConcurrency);
  }

  async fetch(
    url: string,
    logger: Logger,
    conditional?: { etag?: string; lastModified?: string },
  ): Promise<PolicedResponse> {
    return this.limit(() => this.fetchWithRetry(url, logger, conditional));
  }

  private async fetchWithRetry(
    url: string,
    logger: Logger,
    conditional?: { etag?: string; lastModified?: string },
  ): Promise<PolicedResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.opts.baseDelayMs * 2 ** (attempt - 1);
        logger.warn({ url: redactUrl(url), attempt, delay }, "retrying fetch");
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await this.fetchOnce(url, conditional);
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
  ): Promise<PolicedResponse> {
    const headers: Record<string, string> = { "user-agent": this.opts.userAgent };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
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
