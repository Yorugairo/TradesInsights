# Handoff → Codex — domain supply for `binding_domain_match`

**From:** Insights (resolution seam). **To:** the website↔entity matching lane (Codex).
**Status:** Insights built the domain-match *demand* side in Phase 4; it is **starving for
supply**. This is a request describing what the registry side needs to produce — **not** code
in your lane. Insights will not touch `registry_entity_websites` / `website_signals`.

## The boundary (restated, non-negotiable)

- Insights **reads** exactly one registry column for domains: `registry_public.trades_identity_v1.root_domain`.
- Insights **never writes** to `registry_entity_websites`, `website_signals`, or any website table.
  Website hydration and entity↔URL matching are wholly your lane.
- This document changes nothing in Insights; it asks the registry side to populate a column
  Insights already reads.

## What the rule needs

`binding_domain_match` (review-only, name-gated, unique-domain index) matches an Insights org's
website root-domain against a registry entity's `root_domain`. On the registry side that column is
derived, per baseline 26 (`26_registry_public_trades_identity_v1_enrichment.sql:29-34`), as:

```sql
WITH strong_ids AS (
  SELECT entity_id,
    max(value_normalized) FILTER (WHERE identifier_type = 'root_domain') AS root_domain
  FROM registry_internal.registry_entity_identifiers
  GROUP BY entity_id
)
```

So the concrete ask: **write per-entity `root_domain` rows into
`registry_internal.registry_entity_identifiers`** — `identifier_type = 'root_domain'`,
`value_normalized = <normalized host>`, `entity_id = <entity>`. That is the same strong-id table
that already carries `ubi` and contractor numbers; the identity view folds a new `root_domain`
row into the contract column with no further view change.

## Normalizer contract (must agree with Insights)

Insights folds its side through `normalizeRootDomain` (`packages/resolution/src/identifiers.ts:239`).
**Both sides fold through the same shape** — a subdomain-vs-apex mismatch then simply fails to match
rather than matching wrongly, but the safest supply writes the identical normalized form:

- lowercase; strip scheme, `user@` userinfo, path/query/fragment, `:port`, a leading `www.`, and a trailing dot;
- reject: no-dot hosts, any whitespace, IPv4 literals, hosts `< 4` chars, and anything not `[a-z0-9.-]`;
- **no eTLD+1 folding** (that needs a public-suffix list to be correct — deliberately omitted);
- reject platform hosts (the value identifies the platform, not the business), matched against the
  full host after `www.`-strip, subdomains included:
  `facebook.com, instagram.com, google.com, yelp.com, angi.com, homeadvisor.com, thumbtack.com,
  linkedin.com, nextdoor.com, bbb.org, yellowpages.com, houzz.com, porch.com`.

If you normalize with a different rule, matches still won't be *wrong* (the demand side re-folds the
read value), but they'll be *missed* whenever the two normal forms differ. Aligning avoids that.

## Why it's at 0 today (both halves are empty)

A domain match needs a domain on **both** sides:

1. **Registry (your lane):** `registry_entity_identifiers` has ~0 `root_domain` rows → the identity
   view's `root_domain` is null for essentially every entity. `pnpm match:audit` shows
   `binding_domain_match` with 0 pending purely for lack of this supply.
2. **Insights (demand side):** `OrgIdentifierInput.website` is wired but **no source adapter emits a
   website field yet** — verified this handoff:
   ```
   grep -rin "website" packages/adapters/src --include='*.ts' | grep -iv url
   → packages/adapters/src/pierce-permits-arcgis.ts:111  (a Cloudflare comment, not a data field)
   ```
   So the org side gets a domain only when (a) a future adapter publishes URLs, or (b) an accepted
   name-binding backfeeds one. Populating the registry side is **necessary but not sufficient** — it
   arms the rule so it lights up as org-side domains arrive.

## Which entities are worth it first

Highest leverage: entities with a **confident website but weak name/phone/address** evidence — the
cases where name/phone/address binding can't fire but a domain would. If your website matcher already
scores confidence, prioritize high-confidence, otherwise-unmatched entities.

## Acceptance from Insights' side

Once `root_domain` identifiers exist and an org-side domain appears, candidates surface in
`/app/admin/registry-review` under `binding_domain_match` (trust component `identifier = 1`,
name-gated, unique-domain). They **never auto-bind** — a human accepts each, exactly like every other
binding rule.
