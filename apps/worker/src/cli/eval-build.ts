import "../load-env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, createPool, type Db } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { loadFeatures, type EvalExample } from "@otn/intelligence";

/**
 * M4.1 — eval-set candidate builder. Samples stratified candidates from the
 * live corpus per labeled category, freezes their scoring features and the
 * labeling clock, and writes JSONL PROPOSALS to --out. The output is reviewed
 * by a human before being committed as fixtures/eval/eval-set.vN.jsonl —
 * generation is reproducible (stable ordering, no randomness), labeling is a
 * human act.
 *
 * pnpm eval:build --out <path>
 */

interface CategorySpec {
  account: EvalExample["account"];
  label: EvalExample["label"];
  category: string;
  rationale: string;
  target: number;
  /** Returns candidate project ids in a stable order. */
  candidates: (db: Db) => Promise<string[]>;
}

// Text conditions run against the same rolled-up text the scorer sees
// (title + description + permit/application/document type, lowercased).
function textQuery(db: Db, where: ReturnType<typeof sql>, limit: number) {
  return db.execute(sql`
    WITH proj_text AS (
      SELECT p.id, p.county, p.permitting_jurisdiction,
        lower(COALESCE(string_agg(
          concat_ws(' ',
            sr.normalized_json->>'title',
            left(sr.normalized_json->>'description', 800),
            sr.normalized_json->>'permitType',
            sr.normalized_json->>'applicationType',
            sr.normalized_json->>'documentType'
          ), ' '), lower(p.canonical_name))) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        max((sr.normalized_json->>'units')::numeric)::float AS max_units
      FROM projects p
      LEFT JOIN record_resolutions rr ON rr.project_id = p.id AND rr.status = 'active'
      LEFT JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE p.permitting_jurisdiction != 'Test Jurisdiction'
      GROUP BY p.id
    )
    SELECT id FROM proj_text WHERE ${where}
    ORDER BY id
    LIMIT ${limit}`);
}

async function ids(db: Db, where: ReturnType<typeof sql>, limit: number): Promise<string[]> {
  const res = await textQuery(db, where, limit);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

const SFR = sql`text ~ 'single family residence|single-family|new sfr'`;
// Records that mention housing vocabulary but are not build opportunities.
const NOT_NON_OPPORTUNITY = sql`text !~ 'after-the-fact|moratorium|code amendments|flood development permit|utility structure|forest land conversion'`;
const NOT_SMALLWORK = sql`text !~ 'reroof|re-roof|roof replacement|demolish|demolition|mechanical only|plumbing only|water heater|furnace|heat pump|generator|solar'`;
const INTERIOR_TI = sql`text ~ 'tenant improvement|tenant space|interior.{0,40}(alteration|remodel|improvement)|demising'`;
const SITE_WORK = sql`text ~ 'synthetic turf|athletic field|grading|paving|parking lot|retaining wall|site work|utility|sewer|watermain|fence'`;
const NON_INTERIOR_TRADE = sql`text ~ 'reroof|re-roof|roof replacement|fire sprinkler|fire suppression|fire alarm|mechanical|hvac|plumbing|electrical service|solar'`;
const DEMO = sql`text ~ 'demolish|demolition|\\ydemo\\y'`;
const COMMERCIAL_BLD = sql`text ~ 'commercial|office|retail|restaurant|school|clinic|medical|hotel|warehouse|mixed[- ]use'`;
const GLAZING = sql`text ~ 'storefront|curtain wall|glazing|window wall|window replacement'`;

const CATEGORIES: CategorySpec[] = [
  // ── Lacey Glass at Home — positives (50) ───────────────────────────────────
  {
    account: "lacey_glass_at_home",
    label: "positive",
    category: "sfr_new",
    rationale:
      "New single-family residence in AH territory at permit stage — windows/doors/shower prospect per §12.1.",
    target: 42,
    candidates: (db) =>
      ids(
        db,
        sql`${SFR} AND ${NOT_SMALLWORK} AND ${NOT_NON_OPPORTUNITY} AND county IN ('Lewis','Thurston')`,
        60,
      ),
  },
  {
    account: "lacey_glass_at_home",
    label: "positive",
    category: "subdivision_cluster",
    rationale:
      "Subdivision/plat or clustered residential development in AH territory — repeatable-units signal per §12.1.",
    target: 8,
    candidates: (db) =>
      ids(
        db,
        sql`text ~ '\\yplat\\y|subdivision|townhome|townhouse' AND text ~ 'single.family|townhome|townhouse|residential|cottage|lot' AND ${NOT_SMALLWORK} AND ${NOT_NON_OPPORTUNITY} AND county IN ('Lewis','Thurston')`,
        16,
      ),
  },
  // ── Lacey Glass at Home — hard negatives (15) ──────────────────────────────
  {
    account: "lacey_glass_at_home",
    label: "hard_negative",
    category: "ah_out_of_territory",
    rationale:
      "SFR in King County — looks like a perfect product fit but King is excluded for At Home until confirmed (§12.1).",
    target: 5,
    candidates: (db) => ids(db, sql`${SFR} AND county = 'King'`, 10),
  },
  {
    account: "lacey_glass_at_home",
    label: "hard_negative",
    category: "ah_small_work",
    rationale:
      "Reroof/mechanical-only work on a residence in territory — residential keywords but no glass scope.",
    target: 10,
    candidates: (db) =>
      ids(
        db,
        sql`text ~ 'reroof|re-roof|roof replacement|heat pump|water heater|solar' AND county IN ('Lewis','Thurston')`,
        20,
      ),
  },
  // ── Lacey Glass Commercial — positives (25) ────────────────────────────────
  {
    account: "lacey_glass_commercial",
    label: "positive",
    category: "commercial_glazing",
    rationale: "Explicit Division 08 vocabulary (storefront/curtain wall/glazing) on a commercial project.",
    target: 8,
    candidates: (db) => ids(db, sql`${GLAZING} AND ${COMMERCIAL_BLD}`, 16),
  },
  {
    account: "lacey_glass_commercial",
    label: "positive",
    category: "commercial_building_alteration",
    rationale:
      "Commercial building addition/substantial alteration ≥ $250k — plausible Division 08 package even without explicit glazing text.",
    // Explicit-glazing vocabulary is rare in the corpus (3 projects at
    // sampling time) — this bucket carries the remainder of the 25 positives.
    target: 22,
    candidates: (db) =>
      ids(
        db,
        sql`${COMMERCIAL_BLD} AND text ~ 'addition|alteration|construct|change of use' AND ${sql`text !~ 'synthetic turf|athletic field|grading|paving|parking lot|retaining wall|site work|utility|sewer|watermain|fence'`} AND ${sql`text !~ 'demolish|demolition|for apartments|mechanical|seismic|construct repairs'`} AND max_valuation >= 250000`,
        30,
      ),
  },
  // ── Lacey Glass Commercial — hard negatives (25) ───────────────────────────
  {
    account: "lacey_glass_commercial",
    label: "hard_negative",
    category: "site_field_work",
    rationale:
      "High-value commercial-adjacent SITE work (turf/grading/paving/fences) — no building envelope, no Division 08 scope (M3.8 finding).",
    target: 10,
    candidates: (db) => ids(db, sql`${SITE_WORK} AND text !~ 'tenant improvement'`, 20),
  },
  {
    account: "lacey_glass_commercial",
    label: "hard_negative",
    category: "demo_only",
    rationale: "Demolition-only permit — precedes opportunity; nothing to glaze.",
    target: 8,
    candidates: (db) => ids(db, sql`${DEMO} AND text !~ 'addition|tenant improvement|new construction'`, 16),
  },
  {
    account: "lacey_glass_commercial",
    label: "hard_negative",
    category: "mep_fire_only",
    rationale: "Fire-suppression/MEP-only permits on commercial buildings — trade mismatch.",
    target: 7,
    candidates: (db) =>
      ids(db, sql`text ~ 'fire sprinkler|fire suppression|fire alarm' AND text !~ 'tenant improvement'`, 14),
  },
  // ── Solis Interiors — positives (50) ───────────────────────────────────────
  {
    account: "solis_interiors",
    label: "positive",
    category: "interior_ti",
    rationale:
      "Interior tenant improvement / demising / interior alteration with package size in Solis's provisional $50k–$2M range (§12.3).",
    target: 50,
    candidates: (db) =>
      ids(
        db,
        sql`${INTERIOR_TI} AND ${sql`text !~ 'reroof|re-roof|roof replacement|fire sprinkler|fire suppression|fire alarm|hvac|plumbing|electrical service|solar|mechanical replacement'`} AND max_valuation BETWEEN 50000 AND 2000000`,
        70,
      ),
  },
  // ── Solis Interiors — hard negatives (35) ──────────────────────────────────
  {
    account: "solis_interiors",
    label: "hard_negative",
    category: "si_non_interior_trade",
    rationale: "Reroof/fire/MEP permits — commercial keywords but no drywall/paint scope.",
    target: 12,
    candidates: (db) => ids(db, sql`${NON_INTERIOR_TRADE} AND ${COMMERCIAL_BLD}`, 24),
  },
  {
    account: "solis_interiors",
    label: "hard_negative",
    category: "si_oversized_new_multifamily",
    rationale:
      "Large new multifamily/mixed-use (> $2M or 100+ units) — GC-relationship radar, not a direct-pursuit priority for Solis's provisional capacity.",
    target: 10,
    candidates: (db) =>
      ids(
        db,
        sql`text ~ 'apartment|multifamily|mixed[- ]use' AND (max_valuation > 2000000 OR max_units >= 100)`,
        20,
      ),
  },
  {
    account: "solis_interiors",
    label: "hard_negative",
    category: "si_residential_small",
    rationale:
      "Small residential interior remodel (< $50k, often STFI) — below Solis's provisional minimum package size.",
    target: 8,
    candidates: (db) =>
      ids(
        db,
        sql`text ~ 'interior.{0,40}remodel|basement' AND text ~ 'dwelling|residence|residential' AND max_valuation < 50000`,
        16,
      ),
  },
  {
    account: "solis_interiors",
    label: "hard_negative",
    category: "si_non_building",
    rationale: "Land-use/SEPA-only or site actions with no interior construction scope.",
    target: 5,
    candidates: (db) =>
      ids(db, sql`${SITE_WORK} AND text !~ 'tenant improvement|interior'`, 10),
  },
];

async function evidenceRefs(db: Db, projectId: string): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT sr.external_id, sr.normalized_json->>'sourceUrl' AS url
    FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    ORDER BY sr.external_id LIMIT 2`);
  return (res.rows as { external_id: string; url: string | null }[]).map((r) =>
    r.url ? `${r.external_id} (${r.url})` : r.external_id,
  );
}

async function main() {
  const logger = createLogger({ app: "eval-build-cli" });
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  if (!out) throw new Error("--out <path> is required");
  // Reviewer rejections ("account:projectId" → reason) — committed alongside
  // the eval set so every case-by-case labeling decision is auditable.
  // Default resolves from the repo root regardless of CWD (pnpm --filter
  // runs CLIs from apps/worker).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const excludeArg = args.includes("--exclude") ? args[args.indexOf("--exclude") + 1]! : null;
  const excludePath = excludeArg
    ? isAbsolute(excludeArg)
      ? excludeArg
      : join(process.cwd(), excludeArg)
    : join(repoRoot, "fixtures", "eval", "review-exclusions.v1.json");
  const exclusions: Record<string, string> = existsSync(excludePath)
    ? (JSON.parse(readFileSync(excludePath, "utf8")) as Record<string, string>)
    : {};

  const pool = createPool();
  const db = createDb(pool);
  try {
    const frozenAt = new Date().toISOString();
    const examples: EvalExample[] = [];
    // One project may only appear once per account across categories.
    const used = new Set<string>();
    let seq = 0;

    for (const spec of CATEGORIES) {
      const candidateIds = (await spec.candidates(db)).filter(
        (id) => !used.has(`${spec.account}:${id}`) && !exclusions[`${spec.account}:${id}`],
      );
      const chosen = candidateIds.slice(0, spec.target);
      const features = await loadFeatures(db, chosen);
      const byId = new Map(features.map((f) => [f.projectId, f]));
      const nameRes = await db.execute(sql`
        SELECT id, canonical_name FROM projects WHERE id IN (${sql.join(
          chosen.map((id) => sql`${id}`),
          sql`, `,
        )})`);
      const names = new Map(
        (nameRes.rows as { id: string; canonical_name: string }[]).map((r) => [
          r.id,
          r.canonical_name,
        ]),
      );

      for (const projectId of chosen) {
        const f = byId.get(projectId);
        if (!f) continue;
        used.add(`${spec.account}:${projectId}`);
        seq++;
        examples.push({
          id: `ev-${String(seq).padStart(3, "0")}`,
          account: spec.account,
          projectId,
          projectName: names.get(projectId) ?? "(unknown)",
          label: spec.label,
          // Stratified 75/25 dev/holdout inside every category.
          split: seq % 4 === 0 ? "holdout" : "dev",
          category: spec.category,
          rationale: spec.rationale,
          evidenceRefs: await evidenceRefs(db, projectId),
          frozenAt,
          features: {
            ...f,
            lastMaterialChangeAt: f.lastMaterialChangeAt?.toISOString() ?? null,
          },
        });
      }
      logger.info(
        { category: spec.category, account: spec.account, target: spec.target, got: chosen.length },
        "category sampled",
      );
    }

    writeFileSync(out, examples.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const positives = examples.filter((e) => e.label === "positive").length;
    logger.info(
      { out, total: examples.length, positives, hardNegatives: examples.length - positives },
      "eval candidates written — review and correct labels before committing",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
