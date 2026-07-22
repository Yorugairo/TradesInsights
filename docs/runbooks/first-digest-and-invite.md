# Runbook — first Solis digest + owner invite

**Audience:** owner/operator, after the seam is live (see `registry-seam-golive.md`).
**Goal:** take the review queue → the first real weekly digest → the owner in the cockpit.
The three flywheels (matching, calibration, revenue) are all built and idle; this runbook
turns the crank the first time.

> **Governance (unchanged):** review is **one decision at a time** — the batch UI is a
> client-side sequential loop over the same per-id endpoint, so every accept still runs
> the binding side effects and the strong-key backfeed. Unknown = null (never fabricate a
> digest fact). Never commit a secret, connection string, or the generated invite password.
> Never target `origin/main`; trades trunk is `release/trades-staging`.

---

## Prerequisites (owner-set env — names only, values live in the deploy env)

| Var | Where | Needed for |
|---|---|---|
| `REGISTRY_DATABASE_URL` | Insights deploy env | the seam (registry identity → scoring, reviewed obs → `registry_partner`) — see golive runbook |
| `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM` | Insights deploy env | actually **sending** a digest (`--send`); without them the digest still builds and stores, just doesn't mail |
| `INBOUND_EMAIL_SECRET` | Insights deploy env | authorizing the inbound-reply webhook (`/api/webhooks/inbound-email/[provider]`) — only if reply intake is wanted |
| `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Registry deploy env | the owner invite (`--apply`) |

None of these have committed defaults. `SMTP_*` default to `localhost:1025` (Mailpit) for a
dry local send.

---

## Step 1 — Work the review queue (bindings first, then digest items)

Open `/app/admin/registry-review` (admin session). Two passes, in order:

1. **Bindings** — 262 pending name-binding candidates. Use `?limit=200` and the per-rule
   filter links to work one rule at a time; `binding_name_exact` is the bulk. Keyboard:
   `j`/`k` move, `x` select, `a`/`r` decide the focused row. Accept applies **immediately**
   (stamps registry identity + backfeeds the entity's UBI/contractor numbers onto the org).
   The batch bar accepts/rejects the selected set sequentially — the confirm dialog shows the
   rule mix; already-decided rows surface as **skipped**, not errors.
2. **Digest items** — the 25 verified Solis review-queue items (extract/verify output). Promote
   or dismiss each; only promoted items reach the digest.

Every decision updates that rule's accept history, which is what the §12.3 calibration session
consumes later (≥50 decided labels unblocks it).

## Step 2 — Build the digest (no send) and inspect

```bash
pnpm digest:run --account solis            # builds + stores; does NOT send
```

The CLI is **idempotent per (account, week)**: a second run returns the *stored* delivery
rather than rebuilding. So if you accepted/promoted anything in Step 1 **after** an earlier
build, the stored draft is stale — delete it before rebuilding:

```sql
-- delete the current-week DRAFT delivery for this account so the next run regenerates.
-- Never delete a delivery whose status = 'sent'.
DELETE FROM deliveries d
USING account_profiles a
WHERE d.account_profile_id = a.id
  AND a.key = 'solis'
  AND d.status <> 'sent'
  AND d.period_end >= date_trunc('week', now());
```

Re-run `pnpm digest:run --account solis` and confirm the section counts in the log
(`priorityNew`, `stageChanges`, `missingFacts`, `monitoring`, `coverageCaveats`). A digest
whose supporting source is red is suppressed (`suppressed` in the log) — that is honest, not a bug.

## Step 3 — Send the first digest

With `SMTP_HOST` / `SMTP_PORT` / `EMAIL_FROM` set:

```bash
pnpm digest:run --account solis --send
```

Idempotent on send too: a delivery already `status = 'sent'` is not re-sent. To pin an exact
period end, add `--end YYYY-MM-DD`.

## Step 4 — Invite the owner (registry side)

From the registry worktree (`trades-google-place-integration-v2`, branch `release/trades-staging`):

```bash
# DRY-RUN by default — prints the exact mutations, writes nothing:
node scripts/invite-trades-owner.mjs \
  --email <owner@domain> --tenant-slug solis-interiors-llc-lacey --account-key solis_interiors

# Then, once the dry-run output is what you want, add --apply:
node scripts/invite-trades-owner.mjs \
  --email <owner@domain> --tenant-slug solis-interiors-llc-lacey --account-key solis_interiors --apply
```

`--apply` needs `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. It grants
the `presence` + `insights` modules (never `waivers` — the trades waiver template is a placeholder),
links the tenant owner, and maps the insights account. It is idempotent (re-running an already-linked
owner reports no-ops; a tenant owned by a *different* user aborts). The generated password prints
**once** to the terminal — capture it then; it is stored nowhere.

## Step 5 — Activation-week checklist

- [ ] Digest email opened / links clicked?
- [ ] Owner logged into the trades cockpit (`/dashboard/insights`)?
- [ ] Any pursuit set to won/lost/no-bid? (each emits a `pursuit_outcome` decision label —
      calibration fuel)
- [ ] Any digest item pursued or dismissed?
- [ ] Capture cadence for the home-metro sources agreed with the operator? (see golive runbook Part A)

If none of the above after a week, the gate is engagement, not the pipeline — revisit the digest
content and the invite, not the code.
