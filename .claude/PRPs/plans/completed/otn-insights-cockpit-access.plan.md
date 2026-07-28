# Plan: OTN → Insights access + cockpit next steps (v2, deep-verified)

## Summary

Two workstreams. **A:** a signed single-use handoff so an OTN-authenticated
tenant owner opens the full Insights app in one click — reusing the
tenant→account mapping OTN **already has** (`public.tenant_insights_accounts`
+ `resolveInsightsAccountKey`), so Insights needs no mapping schema at all.
**B:** cockpit improvements in value order: calibration provenance (every
account still runs owner-assumed 80/65 settings), an alerts card, the
families dropped-group regression chip, and a supervised apply-CLI for the
Solis intake export.

v2 supersedes v1 after a full verification pass; two v1 decisions were
reversed by evidence — see the Decision log.

## User story

As the owner (and later a customer like Solis), I want one login: from the OTN
dashboard I click "Open Insights" and land in my scoped Insights session — and
the cockpit tells me which numbers rest on settings the customer never
confirmed.

## Problem → Solution

Two products, two auths, zero bridge → OTN mints a 60-second single-use HMAC
token carrying the **already-resolved** `accountKey`; Insights verifies,
consumes the `jti`, and sets its normal session cookie. Cockpit shows queue
counts but not calibration state, alerts, or the families regression signal →
three cards + one CLI.

## Metadata

- **Complexity**: Large (cross-repo: TradesInsights + OneTradeNetwork)
- **Source PRD**: N/A — follows the cockpit/seam/residue series
- **Estimated files**: ~15 across two repos

---

## Decision log (what the verification pass changed)

1. **v1's `otn_tenant_id` column on `account_profiles` is KILLED.**
   `OneTradeNetwork/apps/registry/src/lib/insightsCockpit.ts:1-8` documents the
   existing contract: "the tenant→account mapping lives in
   `public.tenant_insights_accounts` (registry migration, member-read RLS)",
   and `resolveInsightsAccountKey(tenantId)` already resolves it. The token
   carries the resolved `accountKey`; a second mapping in Insights would be a
   drift-prone duplicate. Trust: the HMAC signature makes OTN a first-party
   issuer, and the SSO route re-validates with `accountByKey` (exists +
   active) exactly as the login route does.
2. **Reusing `action_tokens` for SSO is REJECTED on schema evidence** —
   `packages/db/src/schema.ts:262-278`: `opportunity_id` is NOT NULL and
   migration 0019 CHECK-pins `action` to `pursue|dismiss`. SSO gets its own
   two-column `sso_consumed` table.
3. **B1 (calibration card) reads the DATABASE, not the yaml.** `apps/web`
   references `@otn/config` only in `next.config.ts` — the web app never
   loads config at runtime, and the hosted deploy may not ship the config
   dir. The seed copies `owner_assumed`/`calibration_pending` (already parsed
   by `AccountProfileSchema`, `packages/config/src/account-config.ts:80-90`)
   into a new `calibration_json` column.
4. **The Insights login page renders no `message` param today**
   (`apps/web/app/login/page.tsx` — accounts + form only). SSO refusal
   redirects need it; the page gains a one-line message banner.
5. **OTN already renders customer-grade insights inside its dashboard**
   (`dashboard/insights/opportunities`, `orgs` — module-gated, reading
   `insights_public.*` contract views only). Workstream A is therefore the
   bridge to the FULL app (detail pages, pursuits, pipeline, admin cockpit),
   not the first insights surface.

## What exploration established (all verified 2026-07-28)

| Fact | Where | Consequence |
|---|---|---|
| Insights session = HMAC cookie `otn_session`, `Session {accountKey, role: customer\|admin}`; "swapping in a real identity provider only replaces this module" | `apps/web/lib/auth.ts:6-23` | SSO route reuses `newSession`/`encodeSession` verbatim |
| Login route: timing-safe secret check, `accountByKey` must exist+active, cookie httpOnly/lax/`path:/`/12h | `apps/web/app/api/auth/login/route.ts:16-48` | The SSO route mirrors lines 40-47 exactly |
| Single-use claim pattern: atomic `UPDATE … WHERE used_at IS NULL` (two concurrent taps cannot both win); raw token never stored, only its hash; **mail gateways prefetch GETs** (peek vs consume split) | `packages/delivery/src/actions.ts:83-144` | SSO consume = `INSERT jti ON CONFLICT` refusal; SSO links must NEVER go into email |
| `action_tokens`: `opportunity_id` NOT NULL, `action` CHECK-pinned | `packages/db/src/schema.ts:262-278` | Separate `sso_consumed` table (Decision 2) |
| OTN auth: Supabase user + `app_metadata.tenant_id`, `tenant_memberships.role` (`owner\|coach\|student\|athlete\|admin`), `getActiveModules` | `OneTradeNetwork/apps/registry/src/lib/tenantAuth.ts:15-52` | Gate mint on role owner/admin AND module |
| Module gating idiom + module key `'insights'` exists | `…/app/dashboard/insights/opportunities/page.tsx:42-53` (`hasModule(modules, "insights")`, `MODULES` from `@gobjj/shared-routes`) | No new module definition needed |
| Tenant→account: `public.tenant_insights_accounts` + `resolveInsightsAccountKey(tenantId)`; provisioned by `scripts/invite-trades-owner.mjs` + registry migration `20260721220000` | `…/lib/insightsCockpit.ts:1-8,55` | Decision 1; Solis provisioning = a row here (ops) |
| OTN repo has THREE copies of the registry app (`apps/registry`, `node_modules/@gobjj/registry`, `scratch/otn-app-full-copy`) | grep hits | Edit `apps/registry` ONLY |
| `AccountProfileSchema` organization block is `.strict()`; `owner_assumed`/`calibration_pending` already parsed | `packages/config/src/account-config.ts:23-31,80-90` | Any new yaml key needs the zod schema extended FIRST or config loading throws |
| Seed upserts `account_profiles` by key via `onConflictDoUpdate` | `packages/db/src/seed.ts:76-99` | `calibrationJson` joins values + set |
| `account_profiles` columns (no calibration field yet) | `packages/db/src/schema.ts:411-426` | 0038 adds `calibration_json` |
| Alerts: `alert_type`, `severity` (`warning\|critical`), `resolved_at`, `alerts_open_ix (alert_type, resolved_at)` | `packages/db/src/schema.ts:1117-1137` | B2's query shape |
| `CockpitFamilies {count, pairsNew, pairsStrong, derivedAt?, stale?}`; sections arrive via `opts` (undefined=derive, null=nothing) | `packages/intelligence/src/cockpit-summary.ts:74-92,139-151` | B3 threads `droppedGroups?` here |
| `FamiliesCard` lives in the cockpit page | `apps/web/app/app/admin/cockpit/page.tsx:316` | B3's render site |
| Web `familyCounts` + persisted snapshot already carry `dropped` | `apps/web/lib/registry-families.ts` (familyCounts), `corporate_family_summary.dropped_json` (live value: 2) | B3 is thread-through, no new read |
| Cockpit e2e = `shell.spec.ts`, a NEW file by rule ("specs are never rewritten to fit") | `apps/web/e2e/shell.spec.ts:1-5` | New cards get a NEW spec file, zero edits to existing ones |
| Config yaml lib is `yaml@^2.7.0` (eemeli) | `packages/config/package.json` | B4 uses `parseDocument`/`setIn` — preserves the file's heavy comments; naive stringify would destroy them |
| No `apps/web/middleware.ts` | glob | Nothing intercepts `/api/auth/sso` |

## UX design

**Before:** OTN dashboard has insights panels but no path into the full app;
Insights requires the passphrase; the cockpit shows numbers with no hint that
territory/thresholds are owner guesses.

**After:** "Open full Insights →" on the OTN insights dashboard (owner +
module gated) lands in a scoped session. Cockpit gains calibration
provenance, alerts, and the dropped-groups chip.

| Touchpoint | Before | After |
|---|---|---|
| OTN `/dashboard/insights` | panels only | + "Open full Insights" (owner+module gated) |
| Insights `/login` | passphrase form | + message banner for SSO refusals |
| Cockpit | queues + families + place | + calibration, + alerts, + dropped chip |

---

## Mandatory reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/web/lib/auth.ts` | all | Session envelope the SSO route reuses |
| P0 | `apps/web/app/api/auth/login/route.ts` | all | Cookie-set + account re-validation to mirror |
| P0 | `packages/delivery/src/actions.ts` | 83-144 | Atomic single-use claim; peek-vs-consume rationale |
| P0 | `OneTradeNetwork/apps/registry/src/lib/tenantAuth.ts` | 15-52 | The two OTN gates |
| P0 | `OneTradeNetwork/apps/registry/src/app/dashboard/insights/opportunities/page.tsx` | 29-62 | Module gate idiom + `resolveInsightsAccountKey` call shape |
| P1 | `packages/intelligence/src/cockpit-summary.ts` | 74-151 | `opts` sections, sequential reads (pool max 2) |
| P1 | `apps/web/app/app/admin/cockpit/page.tsx` | 316+ | Card pattern, budgets, three-state doctrine |
| P1 | `packages/config/src/account-config.ts` | 18-95 | `.strict()` schemas; owner_assumed/calibration_pending |
| P1 | `packages/db/src/seed.ts` | 76-99 | Upsert to extend |
| P2 | `apps/worker/src/cli/purge-e2e-rows.ts` | all | SUPERVISED dry-run/--apply contract for B4 |
| P2 | `docs/meetings/2026-07-26-solis/README.md` | export section | The intake JSON shape B4 consumes |

## External documentation

None — both auth systems are in-repo; `yaml@2` Document API is the only
library nuance and it is pinned in Patterns below.

---

## Patterns to mirror

### SESSION_COOKIE_SET
```ts
// SOURCE: apps/web/app/api/auth/login/route.ts:40-47
const session = newSession(accountKey, role);
const res = NextResponse.json({ ok: true, accountKey, role });
res.cookies.set(SESSION_COOKIE, encodeSession(session), {
  httpOnly: true, sameSite: "lax", path: "/", maxAge: 12 * 60 * 60,
});
```

### HMAC_ENVELOPE (sign + verify, timing-safe)
```ts
// SOURCE: apps/web/lib/auth.ts:25-52 — base64url payload + "." + HMAC-SHA256;
// timingSafeEqual on equal-length buffers; expiry checked AFTER signature.
// The SSO token uses the SAME envelope with a DIFFERENT secret
// (INSIGHTS_SSO_SECRET — never AUTH_SECRET, so the passphrase and the
// handoff rotate independently).
```

### SINGLE_USE_CONSUME (adapted)
```ts
// SOURCE: packages/delivery/src/actions.ts:117-123 — atomic claim:
//   UPDATE action_tokens SET used_at = now()
//   WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > now()
// SSO adaptation: INSERT INTO sso_consumed (jti) VALUES (${jti})
// — a unique-violation IS the replay refusal; no read-then-write race.
```

### ACCOUNT_REVALIDATION
```ts
// SOURCE: apps/web/app/api/auth/login/route.ts:31-38
// A customer session must name a real, ACTIVE account (accountByKey) —
// the SSO route repeats this even though the token is signed.
```

### OTN_MODULE_GATE
```ts
// SOURCE: OneTradeNetwork …/dashboard/insights/opportunities/page.tsx:42-53
const modulesRes = await query(
  "SELECT module FROM tenant_modules WHERE tenant_id = $1 AND status = 'active'",
  [tenantId]);
if (!hasModule(modulesRes.rows.map(r => r.module), "insights")) { /* upsell panel */ }
```

### COCKPIT_SECTION_OPTS
```ts
// SOURCE: packages/intelligence/src/cockpit-summary.ts:139-151
// New sections arrive as opts: undefined = derive inline, null = "nothing to
// show" — three states, sequential reads, never Promise.all on the pool.
```

### SUPERVISED_CLI
```ts
// SOURCE: apps/worker/src/cli/purge-e2e-rows.ts — dry-run default, print
// every change, --apply gate, refuse on surprise.
```

### YAML_COMMENT_SAFE_EDIT
```ts
// yaml@^2.7.0 (packages/config/package.json). account-profiles.yaml is
// heavily commented; stringify(parse(x)) DESTROYS comments. B4 must use:
//   const doc = parseDocument(raw); doc.setIn(pathArray, value); doc.toString()
// and refuse any yamlPath that does not already resolve in the document.
```

---

## Files to change

### Workstream A — TradesInsights
| File | Action | Justification |
|---|---|---|
| `packages/db/src/schema.ts` | UPDATE | `ssoConsumed` table; `calibrationJson` on `account_profiles` |
| `packages/db/migrations/0038_sso_and_calibration.sql` (+journal idx 38, when 1784348000000) | CREATE | Additive only; new file + journal entry, never edit an applied migration |
| `packages/db/src/seed.ts` | UPDATE | Carry `calibration_json` (owner_assumed + calibration_pending) through the upsert |
| `apps/web/lib/sso.ts` | CREATE | Token codec: `verifySsoToken(raw, {secret, now})` → typed result; pure + injectable for tests |
| `apps/web/lib/sso.test.ts` | CREATE | Codec unit tests (vitest picks up `apps/web/**/*.test.ts`) |
| `apps/web/app/api/auth/sso/route.ts` | CREATE | Verify → consume jti → re-validate account → cookie → redirect |
| `apps/web/app/login/page.tsx` | UPDATE | Render `searchParams.message` (Decision 4) |

### Workstream A — OneTradeNetwork (`apps/registry` ONLY — three copies exist)
| File | Action | Justification |
|---|---|---|
| `src/app/api/insights/handoff/route.ts` | CREATE | `requireTenantRole(["owner","admin"])` + module gate + `resolveInsightsAccountKey` → mint → 302 |
| `src/app/dashboard/insights/…` (panel/ui) | UPDATE | "Open full Insights →" link beside the existing panels |
| env (both deployments) | OPS | `INSIGHTS_SSO_SECRET` (shared), `INSIGHTS_BASE_URL` (OTN), `INSIGHTS_SSO_ADMIN_USER_IDS` (Insights) |

### Workstream B — TradesInsights
| File | Action | Justification |
|---|---|---|
| `packages/intelligence/src/cockpit-summary.ts` | UPDATE | `alerts` + `calibration` sections; `CockpitFamilies.droppedGroups?` |
| `packages/intelligence/src/cockpit-summary.test.ts` | UPDATE | Stub-Db tests for the new sections |
| `apps/web/lib/registry-families.ts` | UPDATE | `familyCounts` gains `droppedGroups: s.dropped.length` |
| `apps/web/app/app/admin/cockpit/page.tsx` | UPDATE | CalibrationCard, AlertsCard, dropped chip in FamiliesCard (~:316) |
| `apps/web/e2e/cockpit-cards.spec.ts` | CREATE | NEW spec file (never edit existing specs) |
| `apps/worker/src/cli/apply-calibration.ts` + root/worker `package.json` script | CREATE | B4: intake JSON → yaml Document diff, dry-run default |

## NOT building

- **Supabase adoption inside Insights** — the handoff makes it unnecessary
  now; a later identity swap replaces `lib/auth.ts` per its own comment.
- **A tenant→account mapping in Insights** (Decision 1 — OTN owns it).
- **Cookie-domain sharing** — different apex domains; structurally out.
- **Any §12.3 weight change** — B4 prints "requires the §12.3 protocol" for
  weight-bearing answers and refuses to write them.
- **`tacoma_solicitations` port** — standing memory forbids it until
  something reads `insights.solicitations` into the graph.
- **Customer access to `/app/admin/*`** — SSO customer sessions land on
  `/app/opportunities`; cockpit/families remain admin-only (principal names
  are private individuals).
- **SSO links in email or digests** — mail gateways prefetch GETs
  (actions.ts:84-87); the handoff is a dashboard redirect only.

---

## Step-by-step tasks

### Task A1: `sso_consumed` + `calibration_json` (migration 0038)
- **ACTION**: schema + hand-written SQL migration + journal entry idx 38.
- **IMPLEMENT**:
  ```sql
  CREATE TABLE IF NOT EXISTS sso_consumed (
    jti text PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS calibration_json jsonb;
  ```
  Drizzle: `ssoConsumed` table; `calibrationJson: jsonb("calibration_json")`
  (nullable — absent means "seed has not run", distinct from empty lists).
  Seed (`seed.ts:79-97`): add `calibrationJson: { owner_assumed: a.owner_assumed,
  calibration_pending: a.calibration_pending }` to BOTH `.values` and the
  `onConflictDoUpdate.set`.
- **MIRROR**: 0037 migration comment style.
- **GOTCHA**: drizzle applies by journal TIMESTAMP — new file + journal entry
  only.
- **VALIDATE**: migrate local `otn` + `otn_e2e` + production; `pnpm db:seed`;
  `SELECT key, calibration_json->'owner_assumed' FROM account_profiles` shows
  Solis's list.

### Task A2: token codec (`apps/web/lib/sso.ts`)
- **ACTION**: pure functions, secret and clock injected.
- **IMPLEMENT**:
  ```ts
  export interface SsoClaims {
    v: 1;
    accountKey: string;      // resolved OTN-side via tenant_insights_accounts
    tenantId: string;        // audit only — logged, never used for lookup
    sub: string;             // Supabase user id — admin allowlist input
    jti: string;             // random uuid, consumed once
    exp: number;             // ms epoch; mint sets now + 60_000
  }
  export function verifySsoToken(raw, opts: { secret: string; now?: number }):
    | { ok: true; claims: SsoClaims }
    | { ok: false; reason: "invalid" | "expired" };
  ```
  Envelope identical to `encodeSession`/`decodeSession` (auth.ts:25-52):
  base64url payload + `.` + HMAC-SHA256(base64url payload). Signature check
  (timingSafeEqual, equal-length guard) BEFORE JSON.parse; `exp` after.
  Shape-validate claims with zod (login route already uses zod).
- **MIRROR**: `HMAC_ENVELOPE`.
- **GOTCHA**: use `INSIGHTS_SSO_SECRET` via `requireEnv` — never `AUTH_SECRET`
  (independent rotation; OTN must never hold the passphrase secret).
- **VALIDATE**: `sso.test.ts` — round-trip; flipped byte → invalid; truncated →
  invalid; expired → expired; wrong secret → invalid; extra claim → invalid.

### Task A3: SSO endpoint (`apps/web/app/api/auth/sso/route.ts`)
- **ACTION**: `GET ?token=…` — the only unauthenticated route besides login.
- **IMPLEMENT** (order is the security):
  1. `verifySsoToken` → failure ⇒ 302 `/login?message=…`.
  2. Consume: `INSERT INTO sso_consumed (jti) VALUES (${jti})` — catch
     unique-violation ⇒ replay ⇒ 302 refuse. (Opportunistically
     `DELETE FROM sso_consumed WHERE consumed_at < now() - interval '1 day'`
     after a successful insert — tokens live 60s, the table stays tiny, no
     maintenance-chain edit.)
  3. `accountByKey(db(), claims.accountKey)` must return an active account
     (`ACCOUNT_REVALIDATION`) ⇒ else refuse.
  4. Role: `"customer"` unless `claims.sub` is in the comma-separated
     `INSIGHTS_SSO_ADMIN_USER_IDS` env ⇒ `"admin"`.
  5. `SESSION_COOKIE_SET`, then 302: customer → `/app/opportunities`,
     admin → `/app/admin/cockpit`.
  6. Log one line per outcome: `{accountKey, tenantId, sub, outcome}`.
- **GOTCHA**: every refusal is a clean redirect with a human message
  ("That sign-in link expired — go back to OTN and click Open Insights
  again."), never a 500 or a stack trace.
- **GOTCHA**: tenant owners map to `customer`, NEVER admin by default — the
  cockpit displays private principal names.
- **VALIDATE**: local round-trip with a hand-minted token (tsx one-liner);
  replay refused; login page shows the banner (A4).

### Task A4: login message banner
- **ACTION**: `LoginPage` accepts `searchParams: Promise<{ message?: string }>`
  and renders the message above the form (muted, `max-w` matched).
- **GOTCHA**: render as plain text — the param is attacker-writable URL input.
- **VALIDATE**: `/login?message=x` shows the banner; without param, unchanged.

### Task A5: OTN mint + button (OneTradeNetwork `apps/registry` only)
- **ACTION**: `GET /api/insights/handoff`.
- **IMPLEMENT**:
  ```ts
  const ctx = await requireTenantRole(["owner", "admin"]);      // tenantAuth.ts:15
  if ("error" in ctx) return ctx.error;
  const modules = await getActiveModules(ctx.tenantId);          // tenantAuth.ts:46
  if (!hasModule(modules, "insights")) return NextResponse.json({ error: "insights module not active" }, { status: 403 });
  const accountKey = await resolveInsightsAccountKey(ctx.tenantId); // insightsCockpit.ts
  if (!accountKey) return NextResponse.json({ error: "not provisioned" }, { status: 409 });
  // mint claims {v:1, accountKey, tenantId, sub: ctx.user.id, jti: randomUUID(), exp: Date.now()+60_000}
  // sign with INSIGHTS_SSO_SECRET (same envelope as Insights lib/sso.ts)
  return NextResponse.redirect(`${INSIGHTS_BASE_URL}/api/auth/sso?token=${encodeURIComponent(token)}`);
  ```
  Dashboard: "Open full Insights →" anchor to `/api/insights/handoff` beside
  the existing insights panels, rendered only when the module gate passes
  (the pages already compute it).
- **MIRROR**: `OTN_MODULE_GATE`; the codec mirrors A2 byte-for-byte (two
  small copies in two repos is accepted — a shared package across repos is
  out of scope; the codec tests on the Insights side pin the envelope).
- **GOTCHA**: OTN repo has three copies of this app — `apps/registry` only.
- **GOTCHA**: commit → push immediately on OTN's trunk (handoff discipline).
- **VALIDATE**: owner+module → 302 chain lands authenticated;
  student/coach → 403; module off → 403; unprovisioned tenant → 409, and the
  existing "isn't linked yet" panel copy explains the fix.

### Task B1: calibration-provenance card
- **ACTION**: `queueSummary` gains `calibration` section: per active account
  `{key, name, ownerAssumed: number, calibrationPending: number}` read from
  `account_profiles.calibration_json` (one query, sequential). Cockpit card:
  "Solis Interiors — 12 live settings never confirmed · 3 open questions",
  linking to the session doc.
- **MIRROR**: `COCKPIT_SECTION_OPTS`; three-state (absent column ⇒ "not
  seeded yet", never zeros).
- **GOTCHA**: `calibration_json` NULL ≠ empty lists — NULL renders "seed has
  not stamped calibration state", the honest third state.
- **VALIDATE**: stub-Db unit test; live cockpit shows Solis counts matching
  the yaml.

### Task B2: alerts card
- **ACTION**: `queueSummary` gains `alerts`: open (`resolved_at IS NULL`)
  counts by severity + type over `alerts_open_ix`, and last-24h fired count.
  Card shows critical/warning split; zero open renders the quiet state, not a
  celebration.
- **MIRROR**: `COCKPIT_SECTION_OPTS`; alerts schema `schema.ts:1117-1137`.
- **GOTCHA**: pool max 2 — the new read joins the SEQUENTIAL chain, never
  `Promise.all`.
- **VALIDATE**: stub-Db test; live card reflects last night's run (9 fired,
  3 deduped).

### Task B3: families dropped-group chip
- **ACTION**: `familyCounts` (registry-families.ts) returns
  `droppedGroups: s.dropped.length`; `CockpitFamilies` gains
  `droppedGroups?: number` (cockpit-summary.ts:74-92); `FamiliesCard`
  (page.tsx:316) renders an amber chip when >0: "2 over-cap groups dropped —
  agent-filter regression".
- **GOTCHA**: zero renders NOTHING — the chip is a regression flag, not a
  stat.
- **VALIDATE**: chip visible today (live value 2); absent against a fixture
  with none.

### Task B4: calibration apply CLI
- **ACTION**: `pnpm calibration:apply <export.json> [--apply]` in
  `apps/worker/src/cli/apply-calibration.ts`.
- **IMPLEMENT**: parse the intake export (`{account, confirmations:[{id,
  yamlPath, verdict, correction}], answers, gcs}` — solis README §export);
  `parseDocument(account-profiles.yaml)`; for each confirmed/corrected item,
  resolve `yamlPath` inside the account's node — unresolvable path ⇒ REFUSE
  the whole run; print a unified before/after diff; `--apply` ⇒
  `doc.setIn(...)` + remove the matching `owner_assumed` entry + write.
  Weight-bearing paths (`score_components`, `delivery.priority_review_min`,
  `weekly_digest_min`) print "§12.3 protocol required — NOT applied".
- **MIRROR**: `SUPERVISED_CLI`, `YAML_COMMENT_SAFE_EDIT`.
- **GOTCHA**: after `--apply`, re-run `loadAccountProfiles()` in-process and
  fail loudly if the zod parse rejects — never leave config unloadable.
- **GOTCHA**: `gcs` (the GC list) has no yamlPath — print it as a follow-up
  block for the owner, don't guess a destination.
- **VALIDATE**: dry-run over a synthetic export prints the diff; apply
  round-trips and PRESERVES COMMENTS (assert a known comment survives);
  weight path refuses; unknown path refuses.

### Task A6 (ops, owner-gated): secrets + provisioning
- **ACTION**: generate one `INSIGHTS_SSO_SECRET`, set in both deployments;
  set `INSIGHTS_BASE_URL` on OTN and `INSIGHTS_SSO_ADMIN_USER_IDS` (the
  owner's Supabase user id) on Insights; confirm Solis's tenant has its
  `tenant_insights_accounts` row (`scripts/invite-trades-owner.mjs` is the
  provisioning path).
- **VALIDATE**: full click-through in the hosted environments.

---

## Testing strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| codec round-trip | mint→verify | claims equal | — |
| codec tamper | flipped byte / truncation / wrong secret / extra claim | invalid | ✓ |
| codec expiry | exp < now | expired | ✓ |
| SSO replay | same jti twice | second refused via unique violation | ✓ |
| SSO unknown account | accountKey with no active row | refused | ✓ |
| SSO role | sub not allowlisted | customer session, cockpit 403s | ✓ |
| login banner | `?message=x` | rendered as text | — |
| OTN gates | student / module off / unprovisioned | 403 / 403 / 409 | ✓ |
| calibration section | stub rows incl. NULL json | counts + third state | ✓ |
| alerts section | stub open/resolved rows | severity split | — |
| dropped chip | snapshot with 2 / with 0 | chip / nothing | ✓ |
| apply CLI | synthetic export | diff; comments survive; weight+unknown paths refuse | ✓ |

## Validation commands

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```
```bash
pnpm db:migrate && pnpm db:seed
```
```bash
cd apps/web && pnpm test:e2e
```

### Manual validation
- [ ] A6 secrets set; Solis provisioned in `tenant_insights_accounts`
- [ ] Hosted click-through: OTN login → Open full Insights → scoped session
- [ ] Cockpit shows calibration counts, alerts, dropped chip with live data

## Acceptance criteria
- [ ] OTN owner with active `insights` module reaches Insights in one click
- [ ] Replay/expired/forged/unmapped tokens refused with a clean login banner
- [ ] Customer SSO sessions cannot reach `/app/admin/*`
- [ ] Cockpit shows calibration provenance, alert counts, dropped-group chip
- [ ] Intake export applies as a printed, supervised, comment-preserving diff
- [ ] No existing e2e spec edited (new coverage in `cockpit-cards.spec.ts`)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Codec drift between the two repos' copies | Medium | Medium (handoff dead, fails closed) | Insights-side tests pin the envelope; failure mode is a login banner, never access |
| Wrong account via stale `tenant_insights_accounts` row | Low | **High** | OTN owns exactly one mapping (no duplicate to drift); SSO logs account+tenant+sub per handoff |
| Secret sprawl between deployments | Medium | Medium | One secret name in both envs; A6 checklist |
| B4 corrupts the commented yaml | Low | High | `parseDocument` only; post-apply reload gate; comment-survival assertion |
| Cockpit card creep past budgets | Low | Low | Sections join the sequential budgeted chain |

## Notes

Order: A1→A2→A3→A4 ship the Insights side complete and testable without OTN;
A5 is one OTN commit; A6 is the owner's 15 minutes. B1–B3 are independent and
small; B4 rides after the Solis session produces a real export. The only
blocking owner inputs are the shared secret and confirming Solis's
provisioning row.
