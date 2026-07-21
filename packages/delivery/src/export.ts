/**
 * WS-D — connector-agnostic CRM sync (the "export" tier).
 *
 * An account pushes its ACTIONABLE opportunities into any CRM two ways:
 *   1. CSV download   — a small, dependency-free RFC-4180 writer (the web
 *                       route streams this as an attachment; the CLI writes it
 *                       to stdout/a file).
 *   2. Outbound webhook — a HubSpot/Zapier-compatible JSON payload POSTed to
 *                       the account's OWN configured endpoint. Deliberately NOT
 *                       a native HubSpot integration: a generic webhook is more
 *                       durable and covers HubSpot via a Zap, with no OAuth.
 *
 * GOVERNANCE (non-negotiable):
 *  1. Outbound POSTs go ONLY to `opts.webhookUrl` — the account's own configured
 *     `delivery_config_json.export.webhook_url`. The destination is NEVER derived
 *     from an opportunity, a permit, a source record, or any observed content.
 *     Row DATA never becomes a POST target. This is the single most important
 *     rule of this module.
 *  2. Account isolation — the query is scoped to ONE `account_profile_id`; one
 *     account's opportunities can never appear in another account's export.
 *  3. A webhook failure/timeout returns a status-discriminated result
 *     (`webhookStatus: "failed"`), never an exception (mirrors the brief/digest
 *     export discipline).
 *  4. The webhook URL is REDACTED in logs (redactUrl) — the raw URL/secret is
 *     never logged.
 *  5. No secrets in the repo — `webhook_url` is account config/env only.
 *  6. The query is bounded by an explicit LIMIT; capping is logged + flagged.
 *
 * No model calls anywhere in this module — deterministic assembly over stored
 * rows, reusing the digest's `generalContractor`/`sourceLinks` loaders and the
 * `bid-window` inference overlay.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  bidTrackFor,
  classify,
  drywallBidWindow,
  type BidWindowStatus,
  type ProjectFeatures,
} from "@otn/intelligence";
import { redactUrl } from "@otn/source-sdk";
import { generalContractor, sourceLinks } from "./digest.js";

/** Bounded export size (opportunities). An export is a batch pull/push, not a
 * hot path; the cap keeps the per-row loader fan-out bounded and the payload
 * small. Capping is surfaced (`capped: true`) and logged. */
export const DEFAULT_EXPORT_LIMIT = 1000;

/** Bounded webhook timeout — a slow/hanging CRM endpoint must not wedge the run. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * "Actionable" for CRM sync = an opportunity the account is (or should be)
 * working:
 *   • the opportunity's own state is action-worthy — `priority_review` (system
 *     flagged it as priority) or `promoted` (a human promoted it); OR
 *   • it has an OPEN pursuit — a pursuit whose state is not terminal.
 * Monitoring-tier (`weekly_digest`), dismissed, and archived opportunities are
 * NOT actionable and are excluded, as are closed pursuits.
 */
export const ACTIONABLE_OPPORTUNITY_STATES = ["priority_review", "promoted"] as const;
/** Terminal pursuit states — an opportunity whose only pursuit is closed is not
 * actionable via the pursuit path (it may still qualify on opportunity state). */
export const CLOSED_PURSUIT_STATES = ["won", "lost", "no_bid", "archived"] as const;

/** One normalized, CRM-friendly export row per actionable opportunity. */
export interface ExportRow {
  opportunityId: string;
  /** HubSpot deal title convention (= the project name). */
  dealname: string;
  /** HubSpot deal "amount" (= the project's max stated valuation, when known). */
  amount: number | null;
  project: string;
  county: string;
  /** The project's current lifecycle stage (permit_issued, construction, …). */
  stage: string;
  /** The account's pursuit-pipeline stage for this opportunity, when a pursuit
   * exists (discovered … follow_up); null when not yet pursued. */
  pursuitState: string | null;
  score: number | null;
  units: number | null;
  /** Verified GC (strongest role) — who to call. Reused from the digest loader. */
  gcName: string | null;
  gcPhone: string | null;
  gcVerified: boolean;
  /** Drywall bid-window inference (typical sequencing; never a promise). */
  bidWindow: BidWindowStatus;
  bidWindowNote: string;
  /** Primary source URL (first cited); `sourceUrls` carries all of them. */
  sourceUrl: string | null;
  sourceUrls: string[];
}

/**
 * The outbound webhook payload — a documented, HubSpot/Zapier-compatible shape.
 * Zapier's "Catch Hook" and HubSpot (via a Zap) accept arbitrary JSON; each
 * `opportunities[]` entry is a flat object whose keys map cleanly onto CRM deal
 * fields (`dealname`, `amount`, …). The envelope carries only export metadata —
 * no cross-account data, no secrets.
 *
 *   {
 *     "source": "otn-insights",
 *     "generatedAt": "2026-07-21T00:00:00.000Z",
 *     "count": 2,
 *     "opportunities": [
 *       { "opportunityId": "…", "dealname": "…", "amount": 250000, "project": "…",
 *         "county": "Thurston", "stage": "permit_issued", "pursuitState": "qualified",
 *         "score": 84, "units": null, "gcName": "…", "gcPhone": "+1…",
 *         "gcVerified": true, "bidWindow": "open", "bidWindowNote": "…",
 *         "sourceUrl": "https://…", "sourceUrls": ["https://…"] }
 *     ]
 *   }
 */
export interface WebhookPayload {
  source: "otn-insights";
  generatedAt: string;
  count: number;
  opportunities: ExportRow[];
}

export type WebhookStatus = "sent" | "failed" | "skipped";

export interface ExportOptions {
  /** GOVERNANCE #1 — the ONLY POST destination. Sourced solely from the account's
   * `delivery_config_json.export.webhook_url` and passed by the caller. Null/absent
   * ⇒ CSV-only (webhookStatus "skipped"); the export never invents a destination. */
  webhookUrl?: string | null;
  /** Bounded query size (default DEFAULT_EXPORT_LIMIT). */
  limit?: number;
  /** Bounded webhook timeout in ms (default DEFAULT_WEBHOOK_TIMEOUT_MS). */
  timeoutMs?: number;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ExportResult {
  accountProfileId: string;
  exported: number;
  webhookStatus: WebhookStatus;
  /** Present only when webhookStatus is "failed" — a short, non-sensitive reason. */
  webhookReason?: string;
  csv: string;
  /** The same rows serialized as the webhook/JSON-download payload. */
  payload: WebhookPayload;
  /** True when the actionable set exceeded the LIMIT and was truncated. */
  capped: boolean;
}

/** The account's export config, read from `delivery_config_json.export` at runtime
 * (mirrors how the digest reads `delivery_config_json.easy_win`). */
export interface ExportConfig {
  webhook_url: string | null;
  format: "csv" | "json";
}

/**
 * Read one account's export config from its stored delivery config. Null when the
 * account has no `export` block configured (owner hasn't set it up) — the caller
 * then does a CSV-only run. Account-scoped by id.
 */
export async function accountExportConfig(
  db: Db,
  accountProfileId: string,
): Promise<ExportConfig | null> {
  const res = await db.execute(
    sql`SELECT delivery_config_json FROM account_profiles WHERE id = ${accountProfileId}`,
  );
  const row = res.rows[0] as
    | { delivery_config_json: { export?: Partial<ExportConfig> } | null }
    | undefined;
  const cfg = row?.delivery_config_json?.export;
  if (!cfg) return null;
  return {
    webhook_url: cfg.webhook_url ?? null,
    format: cfg.format ?? "csv",
  };
}

interface PursuitCandidateRow {
  id: string;
  project_id: string;
  canonical_name: string;
  county: string;
  permitting_jurisdiction: string;
  current_stage: string;
  current_score: number | null;
  route: string | null;
  pursuit_state: string | null;
  text: string | null;
  max_valuation: number | null;
  max_units: number | null;
  latest_issue_date: string | null;
}

/**
 * Load the account's ACTIONABLE opportunities (bounded). Account-scoped by
 * `account_profile_id` — GOVERNANCE #2. Fetches LIMIT+1 to detect capping.
 * At most one pursuit per (account, opportunity) exists (unique index), so the
 * LEFT JOIN never fans a row out.
 */
async function loadActionablePursuits(
  db: Db,
  accountProfileId: string,
  limit: number,
): Promise<PursuitCandidateRow[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.project_id, p.canonical_name, p.county, p.permitting_jurisdiction,
      p.current_stage, o.current_score, o.route,
      pu.state AS pursuit_state,
      COALESCE(rec.text, lower(p.canonical_name)) AS text,
      rec.max_valuation, rec.max_units, rec.latest_issue_date
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    LEFT JOIN pursuits pu
      ON pu.opportunity_id = o.id AND pu.account_profile_id = o.account_profile_id
    LEFT JOIN LATERAL (
      SELECT lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800)), ' ')) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        max((sr.normalized_json->>'units')::int) FILTER (
          WHERE (sr.normalized_json->>'units') ~ '^[0-9]+$') AS max_units,
        max(sr.normalized_json->>'issueDate') AS latest_issue_date
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.account_profile_id = ${accountProfileId}
      AND (
        o.state IN ('priority_review', 'promoted')
        OR (pu.id IS NOT NULL AND pu.state NOT IN ('won', 'lost', 'no_bid', 'archived'))
      )
    ORDER BY o.current_score DESC NULLS LAST, o.id
    LIMIT ${limit + 1}`);
  return res.rows as unknown as PursuitCandidateRow[];
}

/** Deterministic drywall bid-window inference for one candidate (bid-window.ts). */
function bidWindowFor(row: PursuitCandidateRow): { status: BidWindowStatus; note: string } {
  const cls = classify({
    projectId: row.project_id,
    county: row.county,
    permittingJurisdiction: row.permitting_jurisdiction,
    city: null,
    stage: row.current_stage,
    text: row.text ?? "",
    maxUnits: row.max_units,
    maxValuation: row.max_valuation === null ? null : Number(row.max_valuation),
    clusterSize: 0,
    hasVelocitySignal: false,
    orgs: [],
    aGradeEvidence: 0,
    lastMaterialChangeAt: null,
  } satisfies ProjectFeatures);
  const w = drywallBidWindow({
    stage: row.current_stage,
    track: bidTrackFor(cls),
    issuedAt: row.latest_issue_date ? new Date(row.latest_issue_date) : null,
  });
  return { status: w.status, note: w.note };
}

/** Build the normalized export row for one candidate (reuses digest loaders). */
async function buildExportRow(db: Db, row: PursuitCandidateRow): Promise<ExportRow> {
  const [gc, links] = await Promise.all([
    generalContractor(db, row.project_id),
    sourceLinks(db, row.project_id),
  ]);
  const bw = bidWindowFor(row);
  const urls = links.map((l) => l.url).filter((u) => u.length > 0);
  return {
    opportunityId: row.id,
    dealname: row.canonical_name,
    amount: row.max_valuation === null ? null : Number(row.max_valuation),
    project: row.canonical_name,
    county: row.county,
    stage: row.current_stage,
    pursuitState: row.pursuit_state ?? null,
    score: row.current_score === null ? null : Number(row.current_score),
    units: row.max_units === null ? null : Number(row.max_units),
    gcName: gc?.name ?? null,
    gcPhone: gc?.phone ?? null,
    gcVerified: gc?.verified ?? false,
    bidWindow: bw.status,
    bidWindowNote: bw.note,
    sourceUrl: urls[0] ?? null,
    sourceUrls: urls,
  };
}

// ── CSV (small, dependency-free, RFC-4180) ───────────────────────────────────

/** Column order for the CSV export (snake_case headers mirror the JSON keys). */
const CSV_COLUMNS: { header: string; get: (r: ExportRow) => unknown }[] = [
  { header: "opportunity_id", get: (r) => r.opportunityId },
  { header: "dealname", get: (r) => r.dealname },
  { header: "amount", get: (r) => r.amount },
  { header: "project", get: (r) => r.project },
  { header: "county", get: (r) => r.county },
  { header: "stage", get: (r) => r.stage },
  { header: "pursuit_state", get: (r) => r.pursuitState },
  { header: "score", get: (r) => r.score },
  { header: "units", get: (r) => r.units },
  { header: "gc_name", get: (r) => r.gcName },
  { header: "gc_phone", get: (r) => r.gcPhone },
  { header: "gc_verified", get: (r) => r.gcVerified },
  { header: "bid_window", get: (r) => r.bidWindow },
  { header: "bid_window_note", get: (r) => r.bidWindowNote },
  { header: "source_url", get: (r) => r.sourceUrl },
  { header: "source_urls", get: (r) => r.sourceUrls.join(" | ") },
];

/**
 * RFC-4180 field: a value is quoted (with embedded quotes doubled) iff it
 * contains a comma, quote, or newline. Null/undefined ⇒ empty; booleans/numbers
 * stringify verbatim. Prevents CSV injection of extra columns/rows via a GC name
 * or project title that contains a comma or quote.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize export rows to a CSV string (header row + one row per opportunity). */
export function pursuitsToCsv(rows: ExportRow[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvField(c.get(r))).join(","));
  // CRLF line endings per RFC-4180 (Excel-friendly).
  return [header, ...body].join("\r\n") + "\r\n";
}

/** Serialize export rows to the documented webhook/JSON payload. */
export function pursuitsToPayload(rows: ExportRow[]): WebhookPayload {
  return {
    source: "otn-insights",
    generatedAt: new Date().toISOString(),
    count: rows.length,
    opportunities: rows,
  };
}

// ── Outbound webhook (governance #1/#3/#4) ────────────────────────────────────

/**
 * POST the payload to the account's OWN configured webhook. Never throws:
 * a non-2xx, a network error, or a timeout all resolve to
 * `{ status: "failed", reason }`. The URL is redacted in every log line. The
 * destination is the caller-supplied `url` ONLY — this function is never handed
 * a URL taken from row/observed data.
 */
export async function postWebhook(
  url: string,
  payload: WebhookPayload,
  opts: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    logger?: ExportOptions["logger"];
  } = {},
): Promise<{ status: "sent" | "failed"; reason?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const safeUrl = redactUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const reason = `http ${res.status}`;
      opts.logger?.warn({ url: safeUrl, status: res.status, count: payload.count }, "export webhook non-2xx");
      return { status: "failed", reason };
    }
    opts.logger?.info({ url: safeUrl, status: res.status, count: payload.count }, "export webhook sent");
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn({ url: safeUrl, reason, count: payload.count }, "export webhook failed");
    return { status: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Export one account's actionable opportunities to CSV + a webhook-ready JSON
 * payload, and (when a webhook URL is configured) POST it there. Account-scoped;
 * status-discriminated; never throws on IO — a webhook failure returns
 * `webhookStatus: "failed"`, and a missing URL returns "skipped" (CSV still
 * produced).
 */
export async function exportPursuits(
  db: Db,
  accountProfileId: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const limit = opts.limit ?? DEFAULT_EXPORT_LIMIT;
  const candidates = await loadActionablePursuits(db, accountProfileId, limit);
  const capped = candidates.length > limit;
  const kept = capped ? candidates.slice(0, limit) : candidates;
  if (capped) {
    opts.logger?.warn(
      { accountProfileId, limit, actionable: candidates.length },
      "export capped — actionable set exceeded the limit",
    );
  }

  const rows: ExportRow[] = [];
  for (const c of kept) {
    rows.push(await buildExportRow(db, c));
  }

  const csv = pursuitsToCsv(rows);
  const payload = pursuitsToPayload(rows);

  // GOVERNANCE #1 — the POST target is opts.webhookUrl (the account's own config)
  // and nothing else. No webhook configured ⇒ CSV-only, status "skipped".
  let webhookStatus: WebhookStatus = "skipped";
  let webhookReason: string | undefined;
  if (opts.webhookUrl) {
    const result = await postWebhook(opts.webhookUrl, payload, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    webhookStatus = result.status;
    if (result.reason !== undefined) webhookReason = result.reason;
  }

  opts.logger?.info(
    {
      accountProfileId,
      exported: rows.length,
      webhookStatus,
      capped,
      webhookConfigured: Boolean(opts.webhookUrl),
    },
    "export complete",
  );

  return {
    accountProfileId,
    exported: rows.length,
    webhookStatus,
    ...(webhookReason !== undefined ? { webhookReason } : {}),
    csv,
    payload,
    capped,
  };
}
