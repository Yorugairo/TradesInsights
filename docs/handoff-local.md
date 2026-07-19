# Handoff — running OTN Insights locally to unblock datacenter egress

Some official sources 403 / connection-reset from this hosted environment's
datacenter IP (path-level WAF filtering, **not** robots or terms — those were
reviewed at activation). A local run from a residential/office connection
reaches them as a normal authorized visitor. This doc is the turnkey handoff.

> **Never bypass.** We collect as an ordinary visitor. No CAPTCHA/MFA/WAF
> evasion, no credential use. If a host still refuses a normal browser, it stays
> a documented blocker. Capturing bytes you can see in your own browser and
> saving them as fixtures is the sanctioned pattern (the same "customer-provided
> file" path already used for Tumwater in `docs/source-policy.md`).

## State is already portable — you are not migrating data

- **Code + design:** all committed & pushed.
  - `Yorugairo/TradesInsights` → branch `claude/tmux-install-320aiz`
  - `Yorugairo/BJJRegistry` → branch `claude/insights-integration-seam`
- **Registry** (Supabase "Trades", project `arbmeioglflvzoffgtii`) is cloud —
  reachable from any IP with the credential; nothing to move.
- **Handoff memory** is `docs/STATUS.md` + `docs/integration-one-trade-network.md`
  + `docs/source-policy.md` + `.claude/learned/LEARNED.md`. A fresh local Claude
  Code session reads `CLAUDE.md` → these and is fully primed. The chat transcript
  does **not** need to move.
- **The corpus is regenerable** — adapters are idempotent, evidence re-derives
  from sources. `pnpm db:seed` + running the (unblocked) adapters rebuilds it.
  Human review decisions, the private bid inbox, and account calibration are the
  only non-regenerable state, and none of the blocked-source work touches them.
  Do **not** bother `pg_dump`-ing the datacenter Postgres for this.

## Two shapes of "local" — pick by goal

- **A — capture-only (lightest).** Keep working in the hosted session; use a
  local browser/machine only to grab the blocked bytes into `fixtures/<key>/`,
  commit, push. The hosted session builds the parser against the real bytes.
- **B — full local Claude Code.** Run the whole loop locally. Setup below.

Also worth checking before B: Claude Code **self-hosted runners** (the `ccpool_`
environment kind) can give the web session non-datacenter egress without a local
dev loop — see `code.claude.com/docs`.

## Full local setup (Option B)

```bash
# 1. Claude Code CLI (see code.claude.com/docs for the current installer)
# 2. Clone + branches
git clone https://github.com/Yorugairo/TradesInsights && cd TradesInsights
git checkout claude/tmux-install-320aiz
# (registry, only if working the loader side)
git clone https://github.com/Yorugairo/BJJRegistry
git -C BJJRegistry checkout claude/insights-integration-seam

# 3. Secrets — NEVER commit these
cp .env.example .env
#   DATABASE_URL           → compose default is fine
#   SOURCE_USER_AGENT      → keep the transparent bot UA
#   REGISTRY_DATABASE_URL  → the otn_insights_reader/writer credential (ops gate);
#                            set it and link/observe/export go live. Leave unset
#                            to keep those steps in their visible "skipped" state.
#   OPENROUTER_API_KEY / OPENROUTER_MODEL / LLM_MONTHLY_BUDGET_USD → optional

# 4. Stack + schema + seed
pnpm install && pnpm infra:up && pnpm db:migrate && pnpm db:seed

# 5. Browser (local is easier than the datacenter — no /opt/pw-browsers override)
npx playwright install chromium

# 6. Parity check (expect green)
pnpm typecheck && pnpm lint && pnpm test

# 7. Rebuild the corpus you need (unblocked open layers)
pnpm source:run pierce_permits_arcgis      # 7,453 Pierce permit IDs, no contractor
# …plus any other enabled sources you want locally
```

Then start `claude` in the repo — `CLAUDE.md` + `STATUS.md` prime it.

## Priority unblock: Pierce PALS `contractorInfo` (the phone/UBI supply)

This is the high-value one. The phone-matching lane (migration `0023`
`organization_identifiers` + the `binding_phone_match` / `binding_name_phone`
rules) is **already built and tested (450 green)** — it is waiting only on the
identifier supply, and Pierce PALS is the cleanest supply.

**Why it matters:** `pierce_permits_arcgis` gives us 7,453 permit IDs but **zero
contractors** — the ArcGIS layer publishes the permit without the applicant/
contractor. The PALS `contractorInfo` endpoint is the *only* public place the
Pierce contractor name + phone + license appears.

**Endpoint (recovered from PALS' own bundle `palsonline/js/app5.1.3-001.js`):**

```
GET https://pals.piercecountywa.gov/public/api/contractorInfo/:id
```

⚠️ **Do not assume the shape.** We never confirmed (a) whether `:id` is the
`applPermitId` we hold or a different internal key, or (b) the JSON field names —
the datacenter got 403 at the API path before any 200 body. That is exactly what
the local capture resolves. In the browser (dev-tools → Network) on a permit's
department-status page, watch which request carries the contractor block and copy
its **real URL** and **response JSON**.

**Real permit IDs to try** (recent issued Pierce permits we already hold):

```
1067557  1067558  1067555  1067549  1067559   (New Structure, issued)
1067513  (Remodel, complete)
```

Their status pages:
`https://pals.piercecountywa.gov/palsonline/#/permitSearch/permit/departmentStatus?applPermitId=<id>`

**Capture (5–10 permits is plenty for a golden fixture):**

```
fixtures/pierce_pals_contractor/
  <applPermitId>.json        # the raw contractorInfo response, one per permit
  metadata.json              # note the REAL request URL template, the :id meaning,
                             # and a verbatim spot-check (name/phone/license) per file
```

**Build plan once fixtures exist** (the hosted session or a local `claude` can do
this — everything downstream is already in place):

1. New adapter/enrichment step under `packages/adapters/` that, for Pierce
   permits, fetches `contractorInfo` via `httpFetchArtifact`
   (`packages/source-sdk/src/http.ts`) and maps the response to the permit's
   `organizations[]` entry with `role: "primary_contractor"` and the optional
   `phone` / `ubi` / `contractorLicense` fields (already in the
   `NormalizedSourceRecord` schema, migration `0023`-aware).
2. Nothing else to wire: the resolver already calls
   `persistOrganizationIdentifiers` (evidence + strong-key backfeed), and the
   nightly `linkRegistry` + `generateRegistryObservations` already produce
   `binding_phone_match` / strong-key bindings into the review queue.
3. Parser tests against the captured fixtures; `pnpm test` green; update
   `docs/source-policy.md` (flip the PALS recon entry from blocked → activated).

## Other blocked sources (same capture pattern, lower priority)

| Source | Capture target | Fixture dir |
|---|---|---|
| Tumwater NOA/SEPA | the two notice pages + linked `/showpublisheddocument/<id>` PDFs | `fixtures/tumwater_development_review/` |
| Olympia permits | the permit search/detail pages | (verify the live surface first) |
| Chehalis | `ci.chehalis.wa.us/building/page/permits-issued-1` monthly copies | `fixtures/chehalis_permits/` |

Each: capture real bytes → build parser against them → activate. See the
`docs/source-policy.md` "Contractor-identifier supply recon" and suburb-sweep
ledgers for what each surface does and doesn't expose.

## First-local-session kickoff prompt (paste as the first message)

> Read `CLAUDE.md`, `docs/STATUS.md`, and `docs/handoff-local.md`. We are on a
> local machine specifically to unblock the datacenter-egress sources. Confirm
> the stack is up (`pnpm infra:up`, `pnpm typecheck && pnpm test` green). Then
> help me capture Pierce PALS `contractorInfo` for permits 1067557, 1067558,
> 1067513: I'll open the department-status pages in my browser; tell me exactly
> which Network request to save and where. Once I've dropped the JSON into
> `fixtures/pierce_pals_contractor/`, build the enrichment adapter against the
> real shape, wire it for Pierce permits, add fixture-based parser tests, run the
> pipeline so `organization_identifiers` fills and the `binding_phone_match`
> candidates appear in `/app/admin/registry-review`, and update
> `docs/source-policy.md`. Verify-first; never bypass; no claim without a source.

## Secrets checklist (never commit)

`REGISTRY_DATABASE_URL` · `OPENROUTER_API_KEY` · any Supabase credential · MinIO
keys. `.env` is git-ignored — keep it that way. The datacenter `.env` is not in
git, so provide these locally yourself.
