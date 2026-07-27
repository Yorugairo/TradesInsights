/**
 * Bounded retry for TRANSIENT connection faults.
 *
 * Lives in @otn/db rather than any one consumer because the same fault took out
 * three unrelated subsystems on 2026-07-27 (a rescore loop, a source run's
 * terminal write, and six scraper workers). See createPool for the prevention
 * half; this is the recovery half.
 *
 * ⚠️ ONLY SOUND FOR A SINGLE IDEMPOTENT STATEMENT.
 * A retry re-executes the callback. That is safe for an upsert with an explicit
 * ON CONFLICT, or a plain UPDATE by primary key. It is NOT safe for a bare
 * INSERT without a natural key (duplicates rows), nor for a multi-statement
 * transaction (the connection died, so the transaction is already gone and a
 * replay would re-run only part of it). Wrap the smallest idempotent unit, and
 * verify idempotency per call site rather than by pattern-matching.
 */

/** pg / libuv codes that mean "the connection went away", not "the query is wrong". */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01", // admin_shutdown — server terminated the connection
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
]);

const TRANSIENT_MESSAGE =
  /Connection terminated|server closed the connection|Client has encountered a connection error|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connection ended unexpectedly|terminating connection/i;

/**
 * Walk an error graph: `cause` chains AND `AggregateError.errors[]`.
 *
 * Both matter in practice. The 2026-07-27 source-run failure arrived as a
 * DrizzleQueryError whose own message named the SQL, with the real signal
 * (`AggregateError [ETIMEDOUT]`) two levels down in `cause`. Matching only the
 * top-level message classified a connection fault as a query failure — the
 * source was marked failed even though it had parsed its record cleanly.
 */
function* walk(err: unknown, depth = 0): Generator<unknown> {
  if (err === null || err === undefined || depth > 8) return;
  yield err;
  if (typeof err !== "object") return;
  const e = err as { cause?: unknown; errors?: unknown };
  if (e.cause !== undefined) yield* walk(e.cause, depth + 1);
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) yield* walk(inner, depth + 1);
  }
}

export function isTransientConnectionError(err: unknown): boolean {
  for (const node of walk(err)) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const msg = node instanceof Error ? node.message : typeof node === "string" ? node : "";
    if (msg && TRANSIENT_MESSAGE.test(msg)) return true;
  }
  return false;
}

export interface ConnectionRetryOptions {
  /** Total attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff; doubles each attempt (0.5s, 1s, 2s, 4s). Default 500ms. */
  baseDelayMs?: number;
  /** Called before each retry — log it, so a degraded link is visible. */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  options: ConnectionRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // A non-transient error must surface immediately and unchanged: a
      // constraint violation is a bug, and burning four backoffs on it turns a
      // fast failure into a slow one.
      if (attempt >= maxAttempts || !isTransientConnectionError(err)) throw err;
      options.onRetry?.(attempt, err);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
