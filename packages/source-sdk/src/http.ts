import type { Logger } from "pino";
import { FetchPolicy, type PolicedRequest, type PolicedResponse } from "./fetch-policy.js";
import type { DiscoveredArtifact, RawArtifact, RunContext } from "./types.js";

// WeakMap so per-run policies are GC'd with the RunContext in a long-lived worker.
const policies = new WeakMap<RunContext, FetchPolicy>();

/**
 * One shared FetchPolicy per source run, so bounded concurrency and retry
 * budgets apply across every fetch the adapter makes in that run.
 */
export function policyForRun(
  ctx: RunContext,
  options?: { maxConcurrency?: number; timeoutMs?: number; minIntervalMs?: number },
): FetchPolicy {
  const existing = policies.get(ctx);
  if (existing) return existing;
  const policy = new FetchPolicy({ userAgent: ctx.userAgent, ...options });
  policies.set(ctx, policy);
  return policy;
}

/** Fetch a discovered artifact into the spec §5 RawArtifact shape. */
export async function httpFetchArtifact(
  item: DiscoveredArtifact,
  ctx: RunContext,
  options?: {
    policy?: FetchPolicy;
    conditional?: { etag?: string; lastModified?: string };
    logger?: Logger;
  },
): Promise<RawArtifact> {
  const policy = options?.policy ?? policyForRun(ctx);
  const res = await policy.fetch(
    item.canonicalUrl,
    options?.logger ?? ctx.logger,
    options?.conditional,
  );
  return {
    discovered: item,
    body: res.body,
    contentType: res.contentType,
    httpStatus: res.httpStatus,
    headers: res.headers,
    retrievedAt: new Date(),
  };
}

/**
 * A full policed request, including POST, returning the whole response.
 *
 * `httpGet` throws away the status and `Set-Cookie`, which is right for a
 * static discovery page and wrong for an ASP.NET form: WEBS pages via
 * `__doPostBack`, and the postback needs both the ViewState from the previous
 * response body AND the session cookie from its headers. Concurrency, retry
 * classification, timeout and crawl-delay all still apply — the point of
 * routing it through the policy rather than calling fetch() directly.
 */
export async function httpRequest(
  url: string,
  ctx: RunContext,
  options?: { policy?: FetchPolicy; request?: PolicedRequest },
): Promise<PolicedResponse> {
  const policy = options?.policy ?? policyForRun(ctx);
  return policy.fetch(url, ctx.logger, undefined, options?.request);
}

/** Fetch a plain URL (discovery pages) through the run's policy. */
export async function httpGet(
  url: string,
  ctx: RunContext,
  options?: { policy?: FetchPolicy },
): Promise<Buffer> {
  const policy = options?.policy ?? policyForRun(ctx);
  const res = await policy.fetch(url, ctx.logger);
  return res.body;
}
