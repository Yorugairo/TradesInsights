import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@otn/db";
import { checkBudget, type BudgetConfig } from "./extraction/budget.js";
import { persistModelRun } from "./extraction/runs.js";
import type { ModelProvider, ModelResponse } from "./extraction/provider.js";
import { classify, type ProjectFeatures } from "./scoring.js";
import { bidTrackFor, tradeBidWindows, type BidWindowStatus } from "./bid-window.js";

/**
 * WS-F — the account's own natural-language assistant ("what's winnable in
 * Thurston this week?"). A Charlie-style twin of the brief/outreach jobs, with
 * ONE non-negotiable safety contract (governance §1–§5):
 *
 *  1. The model NEVER authors, sees, or influences SQL. It does exactly two
 *     bounded things: (a) map the question to a whitelisted, Zod-validated
 *     STRUCTURED FILTER, and (b) narrate over rows deterministic code already
 *     retrieved. No model output is ever interpolated into a query — the filter
 *     is sanitized against the account's own territory/trade vocabulary, then
 *     turned into a parameterized, account-scoped query with `${value}` bindings.
 *  2. Every query is `WHERE account_profile_id = ${accountProfileId}` with a
 *     bounded LIMIT; one account's opportunities can never surface in another's
 *     answer.
 *  3. Narration references ONLY retrieved rows (a cited row must exist; any
 *     number in the answer must appear in the row menu). Zero rows ⇒ a plain
 *     "nothing matches", never a fabricated result.
 *  4. Budget-gated like the brief: no model key (or no configured budget) ⇒ a
 *     visible `blocked` narration over the SAME deterministic rows (never
 *     unlimited, never a throw). The deterministic keyword fallback still
 *     answers.
 */

/** Bump when the filter/narration prompt or contract semantics change. */
export const ASSISTANT_PROMPT_VERSION = "1.0.0";

const RESULT_LIMIT = 25;
const FILTER_MAX_TOKENS = 300;
const NARRATION_MAX_TOKENS = 400;
const MAX_KEYWORD_LEN = 80;

/** Opportunity states an account may ever be shown (published band only). */
const VISIBLE_STATES = ["priority_review", "weekly_digest", "promoted"] as const;
/** The "priority" cut for priorityOnly. */
const PRIORITY_STATES = ["priority_review", "promoted"] as const;

/** Bid-window statuses that count as "winnable" (reuses the display overlay). */
const WINNABLE_STATUSES: ReadonlySet<BidWindowStatus> = new Set<BidWindowStatus>([
  "confirmed_open",
  "open",
  "opens_soon",
]);

/** Rolling-window day cutoffs; mapped to a date in deterministic code (never by
 * the model). `all` = no cutoff. */
const TIMEFRAME_DAYS = { this_week: 7, this_month: 30, last_90_days: 90, all: null } as const;

/** The 39 Washington counties — the fallback whitelist when an account has no
 * configured territory. The account's own `counties_included` is preferred and
 * further narrows this (governance §4: an account may only ask about its own
 * territory). */
const WA_COUNTIES = [
  "Adams", "Asotin", "Benton", "Chelan", "Clallam", "Clark", "Columbia", "Cowlitz",
  "Douglas", "Ferry", "Franklin", "Garfield", "Grant", "Grays Harbor", "Island",
  "Jefferson", "King", "Kitsap", "Kittitas", "Klickitat", "Lewis", "Lincoln", "Mason",
  "Okanogan", "Pacific", "Pend Oreille", "Pierce", "San Juan", "Skagit", "Skamania",
  "Snohomish", "Spokane", "Stevens", "Thurston", "Wahkiakum", "Walla Walla", "Whatcom",
  "Whitman", "Yakima",
] as const;

/**
 * The whitelisted filter. Everything the model may influence lives here, and
 * every field is validated + sanitized before it can touch a query. `.strict()`
 * so a stray key from the model rejects the parse (we then fall back to the
 * default filter).
 */
export const AssistantFilterSchema = z
  .object({
    counties: z.array(z.string()).default([]),
    trades: z.array(z.string()).default([]),
    timeframe: z.enum(["this_week", "this_month", "last_90_days", "all"]).default("all"),
    bidWindowOpen: z.boolean().default(false),
    priorityOnly: z.boolean().default(false),
    keyword: z.string().max(MAX_KEYWORD_LEN).nullable().default(null),
  })
  .strict();

export type AssistantFilter = z.infer<typeof AssistantFilterSchema>;

const EMPTY_FILTER: AssistantFilter = {
  counties: [],
  trades: [],
  timeframe: "all",
  bidWindowOpen: false,
  priorityOnly: false,
  keyword: null,
};

export type AssistantStatus = "succeeded" | "rejected" | "blocked" | "error";

export interface AssistantMatch {
  opportunityId: string;
  projectId: string;
  projectName: string;
  county: string;
  jurisdiction: string;
  stage: string;
  score: number | null;
  route: string | null;
  /** Strongest-role GC name (deterministic), or null when the project has none. */
  generalContractor: string | null;
  /** The best (drywall-first) bid-window inference for this row; display-only,
   * never a confirmed bid state. Null when no dated evidence supports one. */
  bidWindow: { status: BidWindowStatus; note: string } | null;
}

export interface AssistantResult {
  status: AssistantStatus;
  /** A grounded answer over the retrieved rows — model prose when a key is
   * configured and the narration is grounded; a deterministic template
   * otherwise. Never invents a project, GC, score, or number. */
  answer: string;
  /** The opportunities the DETERMINISTIC query returned (post winnable-filter).
   * These come only from stored rows — never from model output. */
  opportunityIds: string[];
  matches: AssistantMatch[];
  /** The sanitized, whitelisted filter that drove the query. */
  filter: AssistantFilter;
  modelRunId: string | null;
  reason?: string;
}

export interface AssistantOptions {
  budget: BudgetConfig;
  now?: Date;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

const FILTER_SYSTEM_PROMPT = `You translate a trade contractor's plain-English question about THEIR OWN sales opportunities into a strict JSON FILTER. You output ONLY this JSON filter. You may NOT write SQL, prose, or any field not listed. You never see or touch the database — a separate deterministic system runs the query.

Filter shape (all fields optional; omit what the question doesn't ask for):
{
  "counties": string[],   // WA county names the question mentions (from the allowed list only)
  "trades": string[],     // trade keywords the question mentions (from the allowed list only)
  "timeframe": "this_week" | "this_month" | "last_90_days" | "all",
  "bidWindowOpen": boolean,  // true when they ask for what is winnable / biddable now
  "priorityOnly": boolean,   // true when they ask only for top / priority opportunities
  "keyword": string | null   // a single free-text term to match, else null
}

Rules:
- Use ONLY county/trade values from the allowed lists given in the user message. If the question names something not on a list, drop it — do not invent or substitute.
- "winnable", "biddable", "can I bid", "ready to bid", "open for bid" => bidWindowOpen: true.
- "this week" => this_week; "this month" => this_month; "last 90 days"/"this quarter" => last_90_days; otherwise "all".
- Respond with a single JSON object and nothing else (no markdown fences, no commentary).`;

const NARRATION_SYSTEM_PROMPT = `You answer a trade contractor's question about THEIR OWN opportunities, from a FIXED, NUMBERED MENU of opportunities that were ALREADY retrieved for them. You compose a short, plain answer; you never add information and you never write SQL.

Rules (non-negotiable):
- Use ONLY the menu rows. Refer to a row by its ref (r0, r1, …); a ref not in the menu invalidates your answer.
- Every number you write (a score, a count, a dollar amount) MUST appear verbatim in a cited row. Do not invent projects, counties, GCs, scores, or figures.
- If the menu is empty, say plainly that nothing matches — never invent a result.
- Keep it under 80 words, plain English, no headings or lists. Lead with the count and the strongest one or two rows.
- Respond with a single JSON object and nothing else: { "answer": string, "refs": [rowRef, ...] }`;

const NarrationSchema = z
  .object({ answer: z.string().max(1200), refs: z.array(z.string()).default([]) })
  .strict();

// ── Account scope (the whitelist source of truth) ────────────────────────────

interface AccountScope {
  counties: string[];
  trades: string[];
}

/**
 * The account's own territory + trade vocabulary — the ONLY county/trade values
 * a filter may contain. Counties = `counties_included` minus `counties_excluded`
 * (or all WA counties when territory is unset); trades = the account's declared
 * capabilities. Read-only.
 */
export async function loadAccountScope(db: Db, accountProfileId: string): Promise<AccountScope> {
  const res = await db.execute(sql`
    SELECT capabilities_json, territory_json
    FROM account_profiles WHERE id = ${accountProfileId}`);
  const row = res.rows[0] as
    | {
        capabilities_json: unknown;
        territory_json: { counties_included?: string[]; counties_excluded?: string[] } | null;
      }
    | undefined;
  const territory = row?.territory_json ?? {};
  const included = Array.isArray(territory.counties_included) ? territory.counties_included : [];
  const excluded = new Set((territory.counties_excluded ?? []).map((c) => c.toLowerCase()));
  const base = included.length > 0 ? included : [...WA_COUNTIES];
  const counties = base.filter((c) => !excluded.has(c.toLowerCase()));
  const trades = Array.isArray(row?.capabilities_json)
    ? (row!.capabilities_json as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return { counties, trades };
}

// ── Sanitize (drop anything outside the account's own vocabulary) ────────────

/** Build a lowercase→canonical lookup so the model's casing/spacing can't slip
 * an out-of-whitelist value through. */
function canonicalMap(values: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of values) m.set(v.toLowerCase().trim(), v);
  return m;
}

/**
 * Reduce a (possibly model-authored) filter to values the account is actually
 * allowed to ask about. Unknown counties/trades are DROPPED (never substituted);
 * the keyword is trimmed + clamped; timeframe/booleans pass through the Zod enum.
 * The output is safe to bind into a parameterized query — it contains only
 * account-owned vocabulary plus a length-bounded keyword bound as a parameter.
 */
export function sanitizeAssistantFilter(raw: AssistantFilter, scope: AccountScope): AssistantFilter {
  const countyLookup = canonicalMap(scope.counties);
  const tradeLookup = canonicalMap(scope.trades);
  const mapAllowed = (values: string[], lookup: Map<string, string>): string[] => {
    const out: string[] = [];
    for (const v of values) {
      const hit = typeof v === "string" ? lookup.get(v.toLowerCase().trim()) : undefined;
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  };
  const keyword =
    raw.keyword && raw.keyword.trim().length > 0 ? raw.keyword.trim().slice(0, MAX_KEYWORD_LEN) : null;
  return {
    counties: mapAllowed(raw.counties, countyLookup),
    trades: mapAllowed(raw.trades, tradeLookup),
    timeframe: raw.timeframe,
    bidWindowOpen: raw.bidWindowOpen,
    priorityOnly: raw.priorityOnly,
    keyword,
  };
}

// ── Deterministic keyword fallback (no model) ────────────────────────────────

/**
 * Map a question to a filter with NO model — a pure string scan against the
 * account's own whitelist. Used when no provider is configured (the assistant
 * still answers) and as the safe default when a model parse fails. Only matches
 * the account's own counties/trades, so it can never widen scope.
 */
export function parseQuestionDeterministic(question: string, scope: AccountScope): AssistantFilter {
  const q = ` ${question.toLowerCase()} `;
  const counties = scope.counties.filter((c) => {
    const name = c.toLowerCase();
    return q.includes(` ${name} `) || q.includes(`${name} county`) || q.includes(` ${name},`);
  });
  const trades = scope.trades.filter((t) => {
    const token = t.toLowerCase();
    return q.includes(token) || q.includes(token.replace(/_/g, " "));
  });
  let timeframe: AssistantFilter["timeframe"] = "all";
  if (/\bthis week\b|\bpast week\b|\bthis coming week\b/.test(q)) timeframe = "this_week";
  else if (/\bthis month\b|\bpast month\b/.test(q)) timeframe = "this_month";
  else if (/\blast 90\b|\bpast 90\b|\bthis quarter\b|\blast quarter\b/.test(q)) timeframe = "last_90_days";
  const bidWindowOpen = /\bwinnable\b|\bbiddable\b|\bbid (?:now|on|this)\b|\bcan i bid\b|\bready to bid\b|\bopen (?:for )?bids?\b/.test(q);
  const priorityOnly = /\bpriorit(?:y|ies)\b|\bhigh[- ]priority\b|\btop\b|\bbest\b|\bhottest\b/.test(q);
  return { counties, trades, timeframe, bidWindowOpen, priorityOnly, keyword: null };
}

/** Timeframe → date cutoff, computed in deterministic code (never the model). */
export function cutoffFor(timeframe: AssistantFilter["timeframe"], now: Date = new Date()): Date | null {
  const days = TIMEFRAME_DAYS[timeframe];
  return days === null ? null : new Date(now.getTime() - days * 86_400_000);
}

// ── The deterministic, parameterized, account-scoped query ───────────────────

interface OppQueryRow {
  id: string;
  project_id: string;
  canonical_name: string;
  county: string;
  jurisdiction: string;
  current_stage: string;
  current_score: number | null;
  route: string | null;
  text: string | null;
  max_valuation: number | null;
  latest_issue_date: string | null;
}

/**
 * Build the SQL entirely from the SANITIZED filter using drizzle `${value}`
 * parameter BINDINGS — never string concatenation. `account_profile_id` is
 * always bound and always present; the keyword and each whitelisted trade are
 * bound as ILIKE parameters (an injection-y keyword is inert data, never
 * executable SQL). Bounded LIMIT. This is the whole of the guarantee that no
 * model output can reach the query engine as code.
 */
async function runOpportunityQuery(
  db: Db,
  accountProfileId: string,
  filter: AssistantFilter,
  now: Date,
): Promise<OppQueryRow[]> {
  const conds: SQL[] = [
    sql`o.account_profile_id = ${accountProfileId}`,
    sql`o.state IN (${sql.join(VISIBLE_STATES.map((s) => sql`${s}`), sql`, `)})`,
  ];

  if (filter.priorityOnly) {
    conds.push(sql`o.state IN (${sql.join(PRIORITY_STATES.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (filter.counties.length > 0) {
    conds.push(sql`p.county IN (${sql.join(filter.counties.map((c) => sql`${c}`), sql`, `)})`);
  }
  const cutoff = cutoffFor(filter.timeframe, now);
  if (cutoff) {
    conds.push(sql`o.last_material_change_at IS NOT NULL`);
    conds.push(sql`o.last_material_change_at >= ${cutoff.toISOString()}`);
  }
  if (filter.keyword) {
    conds.push(textMatch(filter.keyword));
  }
  if (filter.trades.length > 0) {
    const anyTrade = filter.trades.map((t) => textMatch(t));
    conds.push(sql`(${sql.join(anyTrade, sql` OR `)})`);
  }

  const res = await db.execute(sql`
    SELECT o.id, o.project_id, p.canonical_name, p.county,
      p.permitting_jurisdiction AS jurisdiction, p.current_stage, o.current_score, o.route,
      COALESCE(rec.text, lower(p.canonical_name)) AS text, rec.max_valuation, rec.latest_issue_date
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800)), ' ')) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        max(sr.normalized_json->>'issueDate') AS latest_issue_date
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY o.current_score DESC NULLS LAST
    LIMIT ${RESULT_LIMIT}`);
  return res.rows as unknown as OppQueryRow[];
}

/** A parameterized text match: the project name, or any active record's
 * title/description, ILIKE the (bound) term. The term is a bind parameter — a
 * `'; DROP TABLE …` keyword is matched as literal text, never executed. */
function textMatch(term: string): SQL {
  const like = `%${term}%`;
  return sql`(p.canonical_name ILIKE ${like} OR EXISTS (
    SELECT 1 FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
    WHERE rr.project_id = p.id AND rr.status = 'active'
      AND (sr.normalized_json->>'title' ILIKE ${like}
        OR sr.normalized_json->>'description' ILIKE ${like})))`;
}

/** Strongest-role GC per project (primary_contractor > applicant > owner),
 * batched for the retrieved set. Mirrors the digest's `generalContractor`
 * selection; inlined because packages/intelligence cannot depend on
 * packages/delivery (the dependency runs the other way). Read-only. */
async function loadGeneralContractors(
  db: Db,
  projectIds: string[],
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const res = await db.execute(sql`
    SELECT DISTINCT ON (pr.project_id) pr.project_id, org.canonical_name AS name
    FROM project_roles pr JOIN organizations org ON org.id = pr.organization_id
    WHERE pr.project_id IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})
      AND pr.role IN ('primary_contractor', 'applicant', 'owner')
    ORDER BY pr.project_id,
      CASE pr.role WHEN 'primary_contractor' THEN 1 WHEN 'applicant' THEN 2 ELSE 3 END,
      org.canonical_name`);
  const out = new Map<string, string>();
  for (const r of res.rows as { project_id: string; name: string }[]) out.set(r.project_id, r.name);
  return out;
}

/** Best (drywall-first) bid window for a row, derived in code from stored
 * stage/track/issue-date via the display overlay. Never sets bidding_confirmed. */
function bidWindowFor(row: OppQueryRow, now: Date): { status: BidWindowStatus; note: string } {
  const cls = classify({
    projectId: row.project_id,
    county: row.county,
    permittingJurisdiction: row.jurisdiction,
    city: null,
    stage: row.current_stage,
    text: row.text ?? "",
    maxUnits: null,
    maxValuation: row.max_valuation === null ? null : Number(row.max_valuation),
    clusterSize: 0,
    hasVelocitySignal: false,
    orgs: [],
    aGradeEvidence: 0,
    lastMaterialChangeAt: null,
  } satisfies ProjectFeatures);
  const windows = tradeBidWindows({
    stage: row.current_stage,
    track: bidTrackFor(cls),
    issuedAt: row.latest_issue_date ? new Date(row.latest_issue_date) : null,
    now,
  });
  // Prefer the strongest window (a confirmed/open trade over a closed one);
  // drywall is already first, so a stable "best" pick is the winnable one.
  const best = windows.find((w) => WINNABLE_STATUSES.has(w.status)) ?? windows[0]!;
  return { status: best.status, note: best.note };
}

function toMatches(rows: OppQueryRow[], gcs: Map<string, string>, now: Date): AssistantMatch[] {
  return rows.map((r) => ({
    opportunityId: r.id,
    projectId: r.project_id,
    projectName: r.canonical_name,
    county: r.county,
    jurisdiction: r.jurisdiction,
    stage: r.current_stage,
    score: r.current_score,
    route: r.route,
    generalContractor: gcs.get(r.project_id) ?? null,
    bidWindow: bidWindowFor(r, now),
  }));
}

// ── Narration menu + grounding ───────────────────────────────────────────────

const HUMAN_STAGE: Record<string, string> = {
  permit_issued: "permit issued",
  permit_applied: "permit applied",
  construction: "under construction",
  near_final: "near final",
  bidding_confirmed: "out to bid",
};

function humanStage(stage: string): string {
  return HUMAN_STAGE[stage] ?? stage.replaceAll("_", " ");
}

/** One menu line per retrieved row — the only facts the narrator may use. */
function menuLine(ref: string, m: AssistantMatch): string {
  const parts = [`${m.projectName} — ${humanStage(m.stage)}, ${m.county}`];
  if (m.score !== null) parts.push(`score ${m.score}`);
  if (m.generalContractor) parts.push(`GC ${m.generalContractor}`);
  if (m.bidWindow) parts.push(`bid window: ${m.bidWindow.note}`);
  return `${ref}: ${parts.join("; ")}`;
}

function buildNarrationPrompt(
  question: string,
  matches: AssistantMatch[],
): { prompt: string; refs: string[]; menuText: string } {
  const refs = matches.map((_, i) => `r${i}`);
  const rows = matches.map((m, i) => menuLine(refs[i]!, m)).join("\n");
  // The result count is a real fact we provide, so it is part of the grounding
  // menu — the narrator may state "N opportunities" while any OTHER number must
  // still trace to a row.
  const menuText = `results: ${matches.length}\n${rows}`;
  return {
    prompt: `Question: ${question}\n\nThere are ${matches.length} matching opportunities. Menu (the ONLY rows you may reference):\n${rows}\n\nAnswer the question over the menu per the contract.`,
    refs,
    menuText,
  };
}

/** Digits in a string, normalized (commas/$ stripped) — for substantiation. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/[,$]/g, ""));
}

function stripRefs(text: string): string {
  return text
    .replace(/\[?\br\d+\b\]?/g, "")
    .replace(/\(\s*,?\s*\)/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface GroundingResult {
  ok: boolean;
  answer?: string;
  reason?: string;
}

/**
 * Ground the model narration against the row menu: valid JSON, every cited ref
 * exists, and every number in the prose appears in the menu (no invented score,
 * count, or dollar amount). A violation returns { ok:false } and the caller
 * falls back to the deterministic template — a fabricated answer is never
 * surfaced.
 */
function groundNarration(rawText: string, allowedRefs: string[], menuText: string): GroundingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "narration was not valid JSON" };
  }
  const val = NarrationSchema.safeParse(parsed);
  if (!val.success) return { ok: false, reason: "narration JSON did not match the contract" };
  const refSet = new Set(allowedRefs);
  const unknown = val.data.refs.filter((r) => !refSet.has(r));
  if (unknown.length > 0) return { ok: false, reason: `unknown_ref: ${unknown.join(", ")}` };
  const menuNums = new Set(numbersIn(menuText));
  const invented = numbersIn(val.data.answer).filter((n) => !menuNums.has(n));
  if (invented.length > 0) return { ok: false, reason: `unsubstantiated_number: ${invented.join(", ")}` };
  const answer = stripRefs(val.data.answer);
  if (answer.length === 0) return { ok: false, reason: "empty narration" };
  return { ok: true, answer };
}

// ── Deterministic template answers (no model / zero rows / fallback) ──────────

function countyPhrase(filter: AssistantFilter): string {
  if (filter.counties.length === 0) return "your territory";
  if (filter.counties.length === 1) return filter.counties[0]!;
  return `${filter.counties.slice(0, -1).join(", ")} and ${filter.counties.at(-1)}`;
}

/** A plain, grounded answer built with NO model — the exact facts of the
 * retrieved rows, or an honest "nothing matches". Used whenever the model is
 * unavailable, over budget, errors, or produces an ungrounded draft. */
export function templateAnswer(matches: AssistantMatch[], filter: AssistantFilter): string {
  const winnable = filter.bidWindowOpen ? "winnable " : "";
  if (matches.length === 0) {
    return `Nothing ${winnable}matches that in ${countyPhrase(filter)} right now.`;
  }
  const n = matches.length;
  const lead = matches
    .slice(0, 3)
    .map((m) => {
      const gc = m.generalContractor ? ` (GC ${m.generalContractor})` : "";
      return `${m.projectName} in ${m.county} — ${humanStage(m.stage)}${m.score !== null ? `, score ${m.score}` : ""}${gc}`;
    })
    .join("; ");
  const more = n > 3 ? ` …and ${n - 3} more.` : "";
  return `${n} ${winnable}opportunit${n === 1 ? "y" : "ies"} match in ${countyPhrase(filter)}: ${lead}.${more}`;
}

// ── Orchestration ────────────────────────────────────────────────────────────

// Worst-case pre-flight estimate at Opus-tier pricing ($5/$25 per MTok) across
// BOTH model calls (filter parse + narration). The prompts are small (a curated
// row menu, not raw evidence), so this stays well under the per-job cap.
function estimateAssistantCostUsd(promptChars: number): number {
  const inputTokens = promptChars / 3.5;
  return (inputTokens * 5 + (FILTER_MAX_TOKENS + NARRATION_MAX_TOKENS) * 25) / 1_000_000;
}

/**
 * Answer one question over the account's OWN opportunities. Never throws;
 * every model-using path persists exactly one account-scoped `assistant_query`
 * model_run (succeeded / rejected / blocked / error) and the deterministic
 * query always runs first, so `opportunityIds` reflect stored rows even when
 * the narration is blocked. See the file header for the full safety contract.
 */
export async function assistantQuery(
  db: Db,
  provider: ModelProvider | null,
  accountProfileId: string,
  question: string,
  opts: AssistantOptions,
): Promise<AssistantResult> {
  const now = opts.now ?? new Date();
  const scope = await loadAccountScope(db, accountProfileId);
  const base = {
    jobType: "assistant_query",
    accountProfileId,
    projectId: null,
    promptVersion: ASSISTANT_PROMPT_VERSION,
  };

  // Accumulated model usage across the (up to two) model calls, folded into one
  // persisted run so the budget ledger stays exact.
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const rawTexts: string[] = [];
  const track = (r: ModelResponse) => {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    costUsd += r.costUsd;
    rawTexts.push(r.text);
  };

  // ── No provider: deterministic parse + query + template; blocked narration ──
  if (!provider) {
    const filter = sanitizeAssistantFilter(parseQuestionDeterministic(question, scope), scope);
    const { matches, opportunityIds } = await retrieve(db, accountProfileId, filter, now);
    const answer = templateAnswer(matches, filter);
    const reason = "no model API key configured — narration blocked (deterministic answer served)";
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: "none",
      model: "none",
      status: "blocked",
      resultJson: { answer, filter, opportunityIds } as unknown,
      error: reason,
    });
    opts.logger?.warn({ accountProfileId, modelRunId, matches: matches.length }, reason);
    return { status: "blocked", answer, opportunityIds, matches, filter, modelRunId, reason };
  }

  // ── Budget pre-flight (covers both model calls) ─────────────────────────────
  const preflightChars = FILTER_SYSTEM_PROMPT.length + NARRATION_SYSTEM_PROMPT.length + question.length + 4000;
  const budget = await checkBudget(db, opts.budget, estimateAssistantCostUsd(preflightChars));
  if (!budget.allowed) {
    const filter = sanitizeAssistantFilter(parseQuestionDeterministic(question, scope), scope);
    const { matches, opportunityIds } = await retrieve(db, accountProfileId, filter, now);
    const answer = templateAnswer(matches, filter);
    const reason = budget.reason ?? "budget check failed";
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "blocked",
      resultJson: { answer, filter, opportunityIds } as unknown,
      error: reason,
    });
    opts.logger?.warn({ accountProfileId, modelRunId, spentUsd: budget.spentUsd }, reason);
    return { status: "blocked", answer, opportunityIds, matches, filter, modelRunId, reason };
  }

  const started = Date.now();

  // ── Model call #1: parse the question into a whitelisted filter ─────────────
  let filter: AssistantFilter = EMPTY_FILTER;
  try {
    const parseRes = await provider.complete({
      system: FILTER_SYSTEM_PROMPT,
      prompt: buildFilterPrompt(question, scope),
      maxTokens: FILTER_MAX_TOKENS,
    });
    track(parseRes);
    filter = parseModelFilter(parseRes.text);
  } catch (err) {
    // A parse failure is not fatal — fall back to the deterministic filter so
    // the assistant still answers over the account's rows.
    filter = parseQuestionDeterministic(question, scope);
    opts.logger?.warn(
      { accountProfileId, err: err instanceof Error ? err.message : String(err) },
      "assistant filter parse failed — using deterministic fallback",
    );
  }
  filter = sanitizeAssistantFilter(filter, scope);

  // ── Deterministic retrieval (the model never influences this) ───────────────
  const { matches, opportunityIds } = await retrieve(db, accountProfileId, filter, now);

  // ── Zero rows: honest template, recorded as a succeeded (empty) run ─────────
  if (matches.length === 0) {
    const answer = templateAnswer(matches, filter);
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "succeeded",
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: Date.now() - started,
      resultHash: hashOf(rawTexts),
      resultJson: { answer, filter, opportunityIds } as unknown,
    });
    return { status: "succeeded", answer, opportunityIds, matches, filter, modelRunId };
  }

  // ── Model call #2: narrate, then ground against the row menu ────────────────
  const { prompt, refs, menuText } = buildNarrationPrompt(question, matches);
  let narration: ModelResponse | null = null;
  try {
    narration = await provider.complete({
      system: NARRATION_SYSTEM_PROMPT,
      prompt,
      maxTokens: NARRATION_MAX_TOKENS,
    });
    track(narration);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const answer = templateAnswer(matches, filter);
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "error",
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: Date.now() - started,
      resultHash: hashOf(rawTexts),
      resultJson: { answer, filter, opportunityIds } as unknown,
      error: reason,
    });
    opts.logger?.warn({ accountProfileId, modelRunId }, `assistant narration failed: ${reason}`);
    return { status: "error", answer, opportunityIds, matches, filter, modelRunId, reason };
  }

  const grounded = groundNarration(narration.text, refs, menuText);
  const latencyMs = Date.now() - started;
  if (!grounded.ok) {
    // Ungrounded narration is rejected; the deterministic template is served.
    const answer = templateAnswer(matches, filter);
    const reason = grounded.reason ?? "narration failed grounding";
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "rejected",
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      resultHash: hashOf(rawTexts),
      resultJson: { answer, filter, opportunityIds } as unknown,
      error: reason,
    });
    opts.logger?.warn({ accountProfileId, modelRunId }, `assistant narration rejected: ${reason}`);
    return { status: "rejected", answer, opportunityIds, matches, filter, modelRunId, reason };
  }

  const modelRunId = await persistModelRun(db, {
    ...base,
    provider: provider.name,
    model: provider.model,
    status: "succeeded",
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    resultHash: hashOf(rawTexts),
    resultJson: { answer: grounded.answer, filter, opportunityIds } as unknown,
  });
  opts.logger?.info(
    { accountProfileId, modelRunId, matches: matches.length, costUsd },
    "assistant query succeeded",
  );
  return { status: "succeeded", answer: grounded.answer!, opportunityIds, matches, filter, modelRunId };
}

/** Run the deterministic query and derive matches (rows + GC + bid window),
 * applying the in-code "winnable" filter when the filter asks for it. */
async function retrieve(
  db: Db,
  accountProfileId: string,
  filter: AssistantFilter,
  now: Date,
): Promise<{ rows: OppQueryRow[]; matches: AssistantMatch[]; opportunityIds: string[] }> {
  const rows = await runOpportunityQuery(db, accountProfileId, filter, now);
  const gcs = await loadGeneralContractors(db, rows.map((r) => r.project_id));
  let matches = toMatches(rows, gcs, now);
  if (filter.bidWindowOpen) {
    // "winnable" is derived in code from the overlay — never from the model.
    matches = matches.filter((m) => m.bidWindow !== null && WINNABLE_STATUSES.has(m.bidWindow.status));
  }
  return { rows, matches, opportunityIds: matches.map((m) => m.opportunityId) };
}

function buildFilterPrompt(question: string, scope: AccountScope): string {
  return `Allowed counties (use ONLY these, drop anything else): ${scope.counties.join(", ") || "(none configured)"}
Allowed trades (use ONLY these, drop anything else): ${scope.trades.join(", ") || "(none configured)"}

Question: ${question}

Return the JSON filter.`;
}

/** Parse a model-authored filter; any failure yields the empty default filter
 * (the caller then sanitizes). The model output is never trusted as-is. */
function parseModelFilter(text: string): AssistantFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { ...EMPTY_FILTER };
  }
  const res = AssistantFilterSchema.safeParse(parsed);
  return res.success ? res.data : { ...EMPTY_FILTER };
}

function hashOf(texts: string[]): string {
  return createHash("sha256").update(texts.join("\n")).digest("hex");
}
