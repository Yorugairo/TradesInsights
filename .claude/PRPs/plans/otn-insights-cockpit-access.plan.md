# Plan: OTN → Insights access + cockpit next steps

## Summary

Two workstreams. **A:** a signed single-use handoff so an OTN-authenticated
tenant owner (Supabase auth, e.g. Solis via their WaaS/dashboard) can open the
Insights app without a second login — the bridge the pilot auth module was
explicitly designed to accept. **B:** the next cockpit improvements in value
order: make the *uncalibrated* state visible (every account still runs
owner-assumed 80/65 thresholds), surface alerts and the families regression
signal, and an apply-CLI for the Solis intake export so calibration answers
become config diffs instead of re-typed settings.

## User story

As the owner (and later as a customer like Solis), I want one login: from the
OTN dashboard I click "Open Insights" and land in my scoped Insights session —
and the cockpit tells me which of the numbers it shows rest on settings the
customer has never confirmed.

## Problem → Solution

Two products, two auths (OTN: Supabase + `tenant_memberships`; Insights: pilot
HMAC passphrase cookie), zero bridge → OTN mints a short-lived single-use
token, Insights verifies it and sets its own session cookie. Cockpit shows
queue counts but not calibration state, alerts, or the families regression
signal → three cards + one CLI.

## Metadata

- **Complexity**: Large (cross-repo: TradesInsights + OneTradeNetwork)
- **Source PRD**: N/A — follows the cockpit/seam/residue series
- **Estimated files**: ~14 across two repos

---

## What exploration established (2026-07-28)

| Fact | Where | Consequence |
|---|---|---|
| Insights auth is an HMAC cookie (`otn_session`), `Session {accountKey, role: customer\|admin}`, and the module says "swapping in a real identity provider only replaces this module" | `apps/web/lib/auth.ts` | The SSO endpoint reuses `encodeSession`/`newSession` verbatim — no auth refactor |
| Login sets the cookie httpOnly/lax/12h after checking `accountByKey` | `apps/web/app/api/auth/login/route.ts` | The SSO route mirrors this exactly |
| OTN auth is Supabase: `user.app_metadata.tenant_id` + `tenant_memberships.role` (`owner\|coach\|student\|athlete\|admin`), modules gated by `tenant_modules` | `OneTradeNetwork/apps/registry/src/lib/tenantAuth.ts` | Gate the handoff on role `owner`/`admin` AND an active `insights` module |
| Solis's WaaS lives on OTN (`/sites/solis-interiors-llc-lacey`); accounts are keyed `solis_interiors` etc. in `config/account-profiles.yaml`, `website: null` | both repos | tenant→account mapping must be explicit config, never name-matched |
| Insights already has single-use signed-token machinery (`action_tokens`, consume-once semantics) | `packages/delivery/src/actions.ts` | MIRROR for mint/verify/consume; single-use = `action_tokens` class, never `field_links` (multi-use) |
| Cockpit `queueSummary` sections: resolution review, registry review, lanes, families, googlePlace — **no alerts, no calibration state** | `packages/intelligence/src/cockpit-summary.ts` | Cards B2/B3 are additive `opts`-pattern sections |
| Families snapshot now persisted (0037) incl. `dropped_json`; **live: 1401 families, 2 dropped over-cap groups** — the agent-filter regression signal renders nowhere on the cockpit | `corporate_family_summary` | B3 is a one-chip change with the data already read |
| All three accounts carry identical provisional 80/65 thresholds and `owner_assumed` lists; the Solis intake export carries a `yamlPath` per answer so it can be applied as a config diff | `config/account-profiles.yaml`, `docs/meetings/2026-07-26-solis/README.md` | B1 (visibility) + B4 (apply CLI); §12.3 weight changes stay owner-gated |

## UX design

**Before:** OTN dashboard and Insights are unconnected; Insights requires the
shared passphrase; the cockpit shows healthy-looking numbers with no hint that
territory/thresholds/weights are owner guesses.

**After:** OTN dashboard (owner role, `insights` module active) shows "Open
Insights" → lands in a scoped Insights session. The cockpit gains: a
**calibration card** ("Solis: 12 live settings never confirmed — session
2026-07-26 pending apply"), an **alerts card** (fired/deduped last run, red
sources), and an amber **dropped-groups chip** on the families card.

| Touchpoint | Before | After |
|---|---|---|
| OTN dashboard | no Insights entry | "Open Insights" button (owner+module gated) |
| Insights login | passphrase only | passphrase OR SSO handoff |
| Cockpit | queues + families + place | + calibration, + alerts, + dropped chip |

---

## Mandatory reading

| Priority | File | Why |
|---|---|---|
| P0 | `apps/web/lib/auth.ts` | Session encode/decode the SSO route reuses |
| P0 | `apps/web/app/api/auth/login/route.ts` | Cookie-set pattern to mirror |
| P0 | `packages/delivery/src/actions.ts` | Single-use token mint/verify/consume pattern |
| P0 | `OneTradeNetwork/apps/registry/src/lib/tenantAuth.ts` | `requireTenantRole` + `getActiveModules` gates |
| P1 | `packages/intelligence/src/cockpit-summary.ts` | `opts` pattern for new sections; sequential reads (pool max 2) |
| P1 | `apps/web/app/app/admin/cockpit/page.tsx` | Card pattern, budgets, three-state doctrine |
| P1 | `config/account-profiles.yaml` (solis block) | `owner_assumed` / `calibration_pending` shapes; where `otn_tenant_id` lands |
| P2 | `apps/worker/src/cli/purge-e2e-rows.ts` | SUPERVISED dry-run/--apply contract for the B4 CLI |

## External documentation

None needed — both auth systems are in-repo; no new dependencies.

---

## Patterns to mirror

### SESSION_COOKIE_SET
```ts
// SOURCE: apps/web/app/api/auth/login/route.ts:40-47
const session = newSession(accountKey, role);
res.cookies.set(SESSION_COOKIE, encodeSession(session), {
  httpOnly: true, sameSite: "lax", path: "/", maxAge: 12 * 60 * 60,
});
```

### HMAC_VERIFY_TIMING_SAFE
```ts
// SOURCE: apps/web/lib/auth.ts:34-43 — decodeSession
// base64url payload + "." + HMAC; timingSafeEqual on equal-length buffers;
// expiry checked AFTER signature. The SSO token uses the same envelope.
```

### SINGLE_USE_CONSUME
```ts
// SOURCE: packages/delivery/src/actions.ts (action_tokens)
// verify → mark consumed in one statement → act. A token that cannot be
// marked consumed (already used) is REFUSED. field_links are multi-use and
// must never be used for auth handoff.
```

### COCKPIT_SECTION_OPTS
```ts
// SOURCE: packages/intelligence/src/cockpit-summary.ts (families/googlePlace)
// New sections arrive as opts: undefined = derive inline, null = "nothing to
// show" — three states, sequential reads, never Promise.all on the pool.
```

### SUPERVISED_CLI
```ts
// SOURCE: apps/worker/src/cli/purge-e2e-rows.ts
// dry-run default, print every change, --apply gate, refuse on surprise.
```

---

## Files to change

### Workstream A — TradesInsights
| File | Action | Justification |
|---|---|---|
| `packages/db/src/schema.ts` | UPDATE | `otnTenantId` (text, unique, nullable) on `account_profiles`; `sso_consumed` table (jti pk, consumed_at) |
| `packages/db/migrations/0038_otn_sso.sql` (+journal) | CREATE | Additive only |
| `config/account-profiles.yaml` | UPDATE | `otn_tenant_id` per account (owner supplies Solis's tenant uuid) |
| `packages/db/src/seed.ts` | UPDATE | Carry `otn_tenant_id` yaml → row |
| `apps/web/app/api/auth/sso/route.ts` | CREATE | Verify token, map tenant→account, set cookie, redirect |

### Workstream A — OneTradeNetwork (`apps/registry`)
| File | Action | Justification |
|---|---|---|
| `src/app/api/insights/handoff/route.ts` | CREATE | `requireTenantRole(["owner","admin"])` + `insights` module → mint token → redirect |
| dashboard entry (owner dashboard component) | UPDATE | "Open Insights" link, module-gated |
| env (both deployments) | OPS | `INSIGHTS_SSO_SECRET` (new, shared), `INSIGHTS_BASE_URL` (OTN side) |

### Workstream B — TradesInsights
| File | Action | Justification |
|---|---|---|
| `packages/intelligence/src/cockpit-summary.ts` | UPDATE | `alerts` + `calibration` sections (opts pattern); families gains `droppedGroups` |
| `apps/web/app/app/admin/cockpit/page.tsx` | UPDATE | Three new UI pieces, three-state each |
| `apps/web/lib/registry-families.ts` | UPDATE | expose `dropped.length` through `familyCounts` |
| `packages/config/src/…` (account profiles loader) | UPDATE | expose `owner_assumed`/`calibration_pending` counts if not already |
| `apps/worker/src/cli/apply-calibration.ts` + root script | CREATE | B4: intake JSON → yaml diff, dry-run default |

## NOT building

- **Supabase adoption inside Insights.** The handoff makes it unnecessary now;
  a later identity swap replaces `lib/auth.ts` exactly as its comment says,
  and the SSO route shrinks to a redirect. Separate decision.
- **Cookie-domain sharing.** Different apex domains; a shared cookie is
  structurally impossible and a shared subdomain scheme is a deployment
  decision, not code.
- **Any §12.3 weight change.** B4 prints "requires the §12.3 protocol" for
  weight-bearing answers and refuses to write them; label evidence + eval
  rerun + owner present, per the standing rule.
- **`tacoma_solicitations` port** — standing memory forbids until something
  reads `insights.solicitations` into the graph.
- **Customer access to `/app/admin/*`.** SSO customer sessions land on
  `/app/opportunities`; the cockpit and families pages stay admin-only
  (principal names are private individuals).

---

## Step-by-step tasks

### Task A1: Schema + mapping (Insights)
- **ACTION**: `otnTenantId` on `account_profiles` (unique, nullable) +
  `sso_consumed(jti text pk, consumed_at timestamptz)` table; migration 0038;
  yaml + seed carry-through.
- **MIRROR**: 0037 migration style (comment block, additive-only).
- **GOTCHA**: drizzle applies by journal timestamp — new file + journal entry,
  never edit an applied migration.
- **GOTCHA**: mapping is EXPLICIT config. Never match tenant→account by name —
  the org row is `SOLIS INTERIORS`, the tenant slug is
  `solis-interiors-llc-lacey`, and name-matching is how a wrong account gets
  someone else's pipeline.
- **VALIDATE**: migrate local; seed; `account_profiles.otn_tenant_id` populated
  for accounts the owner mapped; unique index rejects a duplicate.

### Task A2: SSO endpoint (Insights)
- **ACTION**: `GET /api/auth/sso?token=…`. Token envelope = base64url payload +
  HMAC (`INSIGHTS_SSO_SECRET`), payload `{tenantId, jti, role, exp}` with
  `exp ≤ now+60s`. Verify signature (timing-safe) → consume jti (INSERT into
  `sso_consumed`; unique violation ⇒ REFUSE — replay) → look up account by
  `otn_tenant_id` → `newSession(accountKey, "customer")` → cookie → redirect
  `/app/opportunities`. Admin: only when the payload's Supabase user id is in
  `INSIGHTS_SSO_ADMIN_USER_IDS` (env allowlist) → admin session → cockpit.
- **MIRROR**: `SESSION_COOKIE_SET`, `HMAC_VERIFY_TIMING_SAFE`,
  `SINGLE_USE_CONSUME`.
- **GOTCHA**: check signature BEFORE parsing/consuming; expiry after signature;
  every refusal is a 302 to `/login?message=…`, never a stack trace.
- **GOTCHA**: tenant owners map to `customer` role, NEVER admin by default —
  the cockpit displays private principal names.
- **VALIDATE**: unit tests on the verifier (bad sig / expired / replayed /
  unmapped tenant / role escalation attempt each refused); e2e-style local
  round-trip with a hand-minted token.

### Task A3: OTN mint + button (OneTradeNetwork)
- **ACTION**: `GET /api/insights/handoff` — `requireTenantRole(["owner","admin"])`,
  `getActiveModules(tenantId)` must include `"insights"`, mint token, 302 to
  `${INSIGHTS_BASE_URL}/api/auth/sso?token=…`. Dashboard gains the gated link.
- **MIRROR**: OTN's existing module-gated dashboard entries (`tenant_modules`
  pattern per the GoBJJ modular strategy).
- **GOTCHA**: there are TWO copies of the registry app on this machine
  (extraction drift risk — memory `canonical-worktree-vigorous-poitras`).
  This lands in **OneTradeNetwork** only; do not touch the BJJ-repo copy.
- **GOTCHA**: OTN commits/pushes on its own trunk; commit → push immediately
  (handoff discipline).
- **VALIDATE**: logged-in owner with module → 302 chain lands authenticated;
  student/coach → 403; module inactive → 404/upsell, never a mint.

### Task B1: Calibration-state card
- **ACTION**: cockpit card per active account: counts of `owner_assumed`
  items and `calibration_pending`, flagged "live in scoring, never confirmed
  by the customer"; links to the intake/session doc. Data via the config
  loader (config ships with the deploy), not a new table.
- **MIRROR**: `COCKPIT_SECTION_OPTS`; three-state card doctrine.
- **GOTCHA**: this card states provenance, not judgement — "owner-assumed"
  is a fact about the setting, phrased exactly as the yaml comments do.
- **VALIDATE**: cockpit shows "Solis: N settings await confirmation"; unit
  test over a stub config.

### Task B2: Alerts card
- **ACTION**: `queueSummary` gains an `alerts` section: last maintenance run's
  fired/deduped counts + currently-red sources, one query, sequential.
- **GOTCHA**: pool max 2 — the new read is sequential like every other.
- **VALIDATE**: card shows last night's real run (9 fired / 3 deduped);
  stub-Db unit test.

### Task B3: Families dropped-groups chip
- **ACTION**: `familyCounts` exposes `droppedGroups`; FamiliesCard renders an
  amber chip when >0 ("2 over-cap groups dropped — agent-filter regression").
- **GOTCHA**: zero renders NOTHING (a green "0 dropped" is noise); the chip is
  a regression flag, not a stat.
- **VALIDATE**: chip visible today (live value is 2); disappears against a
  fixture snapshot with none.

### Task B4: Calibration apply CLI
- **ACTION**: `pnpm calibration:apply <export.json>` — reads the intake
  export, maps each answer via its `yamlPath`, prints the unified yaml diff
  (dry-run default), `--apply` writes `config/account-profiles.yaml` and moves
  confirmed items out of `owner_assumed`. Weight-bearing paths print
  "§12.3 protocol required" and are NEVER written.
- **MIRROR**: `SUPERVISED_CLI`.
- **GOTCHA**: the export's `yamlPath` values must be validated against the
  actual yaml structure before any write — an unknown path is a refusal, not
  a best-effort insert.
- **VALIDATE**: dry-run over a synthetic export prints the exact diff; apply
  round-trips; a weight path refuses.

---

## Testing strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| SSO verify | valid token | session cookie, redirect | — |
| SSO replay | same token twice | second REFUSED (jti consumed) | ✓ |
| SSO expiry | exp in past | refused | ✓ |
| SSO bad sig | flipped byte | refused before parse | ✓ |
| SSO unmapped tenant | tenant with no account row | refused, no session | ✓ |
| Role escalation | payload role=admin, user not allowlisted | customer refused→ login | ✓ |
| OTN gate | student role / module off | 403 / no mint | ✓ |
| Calibration card | stub config | counts match yaml | — |
| Apply CLI weight path | export with weight answer | refused, §12.3 message | ✓ |

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
- [ ] Owner supplies Solis's OTN `tenant_id` and sets `INSIGHTS_SSO_SECRET` in
      both deployments (ops step — code cannot do this)
- [ ] Full click-through: OTN login → Open Insights → scoped session
- [ ] Cockpit shows calibration counts, alerts, dropped chip with live data

## Acceptance criteria
- [ ] OTN owner with active `insights` module reaches Insights in one click
- [ ] Replay/expired/forged/unmapped tokens all refused with a clean redirect
- [ ] Customer SSO sessions cannot reach `/app/admin/*`
- [ ] Cockpit shows calibration provenance, alert counts, dropped-group chip
- [ ] Intake export applies as a printed, supervised config diff
- [ ] No e2e spec assertion changed

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wrong tenant→account mapping | Low | **High** (someone else's pipeline) | Explicit unique `otn_tenant_id`, owner-supplied; SSO logs account+tenant per handoff |
| Shared secret drift between deployments | Medium | Medium (handoff dead) | One secret, named the same in both envs; failure mode is a clean login redirect |
| Registry-app copy drift (OTN vs BJJ repo) | Medium | Medium | A3 touches OneTradeNetwork only; note in commit |
| Cockpit card creep past budgets | Low | Low | Each new read sequential + budgeted like families/place |

## Notes

Order: A1→A2→A3 ships the access lane end-to-end; B1→B3 are independent and
small; B4 rides after the Solis session produces a real export. The only
blocking owner inputs are Solis's tenant id and the shared secret.
