# Implementation Report: OTN → Insights access + cockpit next steps

## Summary

Both workstreams shipped. An OTN tenant owner can now reach the full Insights
app in one click through a signed, single-use, 60-second handoff — no second
password and no shared cookie domain. The cockpit gained three things that
qualify every number already on it: calibration provenance (Solis runs **7
owner-assumed settings and 8 open questions** nobody has confirmed), alert
posture, and the dropped-family regression chip (live value **2**). A
supervised CLI applies the Solis intake export's mechanical part and prints
the rest.

Two ops steps remain, both owner-only: set `INSIGHTS_SSO_SECRET` in both
deployments and confirm Solis's `tenant_insights_accounts` row.

## Assessment vs reality

| Metric | Predicted (plan v2) | Actual |
|---|---|---|
| Complexity | Large, cross-repo | Large, cross-repo — as predicted |
| Confidence | 9/10 | Held; no plan assumption was wrong, but two designs changed on contact with data |
| Files changed | ~15 | 17 (2 repos) |
| Unit tests | new codec + section tests | 1316/1316 (+18 new) |
| e2e | new spec file | **39/39** (was 29 at session start) |

## Tasks completed

| # | Task | Status | Notes |
|---|---|---|---|
| A1 | `sso_consumed` + `calibration_json` | Complete | Migration **0041**, not 0038 — collision, see Issues |
| A2 | Token codec + tests | Complete | 11 tests, every rejection path |
| A3 | `/api/auth/sso` | Complete | Deviated on unset-secret handling — see Deviations |
| A4 | Login message banner | Complete | Truncated, rendered as text |
| A5 | OTN mint route + button | Complete | Pushed to `codex/otn-app-extraction` |
| B1 | Calibration provenance card | Complete | Three-state: counts / unstamped / none |
| B2 | Alerts card | Complete | Open by severity + 24h fired |
| B3 | Dropped-family chip | Complete | Renders only when > 0 |
| B4 | Calibration apply CLI | Complete | Substantially redesigned — see Deviations |

## Validation results

| Level | Status | Notes |
|---|---|---|
| Static analysis | Pass | `pnpm typecheck` + `pnpm lint` clean (Insights); new OTN route lints clean |
| Unit tests | Pass | 1316/1316, 126 files |
| e2e | Pass | **39/39**, including 6 new cards/SSO tests |
| Migration | Pass | 0041 applied to `otn`, `otn_e2e`, and production |
| Seed | Pass | 3 accounts stamped; Solis 7 assumed / 8 pending |
| CLI end-to-end | Pass | Synthetic export → diff is exactly the 4 confirmed removals |

## Deviations from plan

1. **A3 — unset secret is a refusal, not an exception.** The plan said
   `requireEnv("INSIGHTS_SSO_SECRET")`. The e2e run proved that wrong: with no
   secret the route threw, i.e. a 500 on an unauthenticated route. A
   deployment without the handoff configured is a normal state, so it now
   refuses cleanly like every other failure. The e2e config sets a throwaway
   secret so the signature check is genuinely exercised instead of
   short-circuited.
2. **B4 — redesigned after reading the real export.** The plan assumed each
   answer's `yamlPath` could drive a `setIn`. In fact most `yamlPath` values
   are human labels (`score_components -> geography`, `rules -> routing (stage
   timing)`), corrections are prose ("Drop Lewis, add Mason"), and every
   section 2–4 answer is free text. Refusing on unresolvable paths — the
   plan's rule — would have refused every real export. The tool now writes
   exactly one thing (a confirmed assumption leaves `owner_assumed`) and
   prints everything else beside its path.
3. **B4 — text splice instead of `doc.setIn` + `toString`.** The yaml carries
   hand-written MIXED flow styles; every stringify option combination
   normalized some unrelated block (17 changed lines to remove 4). The tool
   now uses the parser only to locate source ranges and splices the text.
4. **B4 — a 1:1 length tripwire replaced per-path resolution.** The form's
   ASSUMPTIONS array and `owner_assumed` are documented as 1:1 and are paired
   by position; a length mismatch refuses the run outright.
5. **A1 — migration numbered 0041, not 0038** (collision; see Issues).

## Issues encountered

- **Migration number collision.** Another agent committed `0038_takeoff_field`,
  `0039_org_name_quality` and `0040_cockpit_view_name_quality` to this branch
  mid-session. My `0038` was renumbered to **0041**. Also: rewriting the
  journal with `ConvertTo-Json` reformatted all 42 entries (72-line diff) and
  was reverted for a 2-line surgical append — a shared-branch file must not be
  reflowed.
- **`nodeEnd` vs `valueEnd` in yaml ranges.** Using `range[2]` deleted 8 lines
  to remove 4, taking a comment and the head of `calibration_pending` with it —
  and produced **valid** yaml, so validation passed. Only reading the diff
  caught it. Fixed to `range[1]`.
- **`<Link>` would break the handoff.** Next prefetches `<Link>`, which would
  mint and spend the single-use token before the human clicked. The button is a
  plain `<a>` with the lint rule disabled and the reason recorded — the same
  hazard that makes these tokens unsafe to email.
- **Pre-existing, not mine:** two Stripe `apiVersion` type errors in the OTN
  app, and that file's existing "JSX within try/catch" lint pattern (my button
  adds one more instance of it).

## Files changed

**TradesInsights** (`claude/tmux-install-320aiz`) — `807ad89`, `bb087d9`, `ad4ff3b`

| File | Action |
|---|---|
| `packages/db/src/schema.ts` | UPDATE — `ssoConsumed`, `calibrationJson` |
| `packages/db/migrations/0041_sso_and_calibration.sql` (+journal) | CREATE |
| `packages/db/src/seed.ts` | UPDATE — stamp calibration provenance |
| `apps/web/lib/sso.ts` / `sso.test.ts` | CREATE — codec + 11 tests |
| `apps/web/app/api/auth/sso/route.ts` | CREATE |
| `apps/web/app/login/page.tsx` | UPDATE — message banner |
| `packages/intelligence/src/cockpit-summary.ts` / `.test.ts` | UPDATE — 2 sections, 7 tests |
| `apps/web/lib/registry-families.ts` | UPDATE — `droppedGroups` |
| `apps/web/app/app/admin/cockpit/page.tsx` | UPDATE — 2 cards + chip |
| `apps/web/e2e/cockpit-cards.spec.ts` | CREATE — 6 tests |
| `apps/web/playwright.config.ts` | UPDATE — e2e SSO secret |
| `apps/worker/src/cli/apply-calibration.ts` | CREATE |
| `apps/worker/package.json`, `package.json` | UPDATE — `yaml` dep + scripts |

**OneTradeNetwork** (`codex/otn-app-extraction`) — `9b253f05`

| File | Action |
|---|---|
| `apps/registry/src/app/api/insights/handoff/route.ts` | CREATE |
| `apps/registry/src/app/dashboard/insights/page.tsx` | UPDATE — button |

## Tests written

| Test file | Tests | Covers |
|---|---|---|
| `apps/web/lib/sso.test.ts` | 11 | Round-trip, wrong secret, tampered payload, flipped byte, truncation (no throw), garbage/empty, expiry boundary, strict-claim rejections |
| `packages/intelligence/src/cockpit-summary.test.ts` | +5 | Calibration counts, unstamped third state, alert severity split, resolved-but-fired, empty tables |
| `apps/web/e2e/cockpit-cards.spec.ts` | 6 | Both cards render, chip absent at zero, forged token refused + no session, missing token, message rendered as text not markup |

## Next steps

- [ ] **Owner:** generate one `INSIGHTS_SSO_SECRET`, set it in both
      deployments; set `INSIGHTS_BASE_URL` (OTN) and
      `INSIGHTS_SSO_ADMIN_USER_IDS` (Insights).
- [ ] **Owner:** confirm Solis's tenant has a `tenant_insights_accounts` row
      (`scripts/invite-trades-owner.mjs`).
- [ ] Then click through: OTN login → Open full Insights → scoped session.
- [ ] After the Solis session produces a real export, run
      `pnpm calibration:apply <export.json>` and review the dry run.
