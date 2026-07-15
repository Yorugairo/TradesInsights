# Source policy

> Maintained as a deliverable: update this file every time a source goes through the activation checklist (M1 onward) — record verification dates, access decisions, and any blockers. Last updated: M0 (2026-07-15).

## Policy (spec §5–§6, §20)

- Only official public sources; discovery preference: documented API/JSON/CSV → downloadable report → static HTML → authorized email → permitted dynamic lookup → headless browser (approved sources only).
- Never bypass authentication, CAPTCHA, MFA, paywalls, or access controls. Never scrape customer credentials.
- Every fetch uses the explicit `SOURCE_USER_AGENT`, bounded concurrency (default 2), timeouts, and retry classification (429/5xx retryable with backoff; other 4xx fatal).
- Robots and terms are reviewed per source before enabling; the config loader rejects an `enabled` source without `terms_reviewed_at` and `robots_reviewed_at`.
- Raw artifacts are immutable and retained forever; source withdrawal/correction is honored at the record level (`status`, `record_withdrawn`/`record_corrected` events), never by deleting evidence.
- Lookup-class sources enrich known records only — never the sole alert source. Context-class sources never drive opportunity discovery.
- Private/customer-authorized artifacts (bid invitations) are account-scoped with restricted object keys — never in shared data (M4.6).

## Activation ledger

One entry per source, appended when the §5 checklist runs. Format:

```
### <source_key>
- Checklist run: <date> by <who>
- Landing page verified: <date> — <url observed>
- Format/cadence observed: ...
- Robots/terms: <summary + dates>
- Fixtures captured: fixtures/<source-key>/ (<list>)
- Manual sample audit: <n> records compared, <result>
- Shadow-mode runs: <dates, metrics>
- Enabled: <date> | Blocked: <reason>
```

### fake_source
- Checklist run: 2026-07-15 (M0 harness — not a live source).
- Fixture-backed only; never fetches the network. Exists to prove the M0 exit gate: discover → fetch → store/hash → parse → idempotent rerun → health.
- Fixtures: `fixtures/fake_source/` (manifest.json, permits-2026-06.json, permits-2026-07.json — includes one deliberately malformed row that must be rejected).
- Enabled: yes (test class).

## Known migration canaries (watch during M1)

- **Thurston County**: new permitting system announced for September 2026 — verify the "what's new" page before and during M1.9.
- **Lewis County**: `lewis_source_canary` watches the Community Development landing page for link changes; SmartGov hostname must be discovered from the official page, never guessed.
- **Seattle**: `seattle_source_canary` watches the Research-a-Project page; inspect live Socrata columns before coding M1.7.
