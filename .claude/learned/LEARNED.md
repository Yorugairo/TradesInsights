# Learned lessons (project self-learning loop)

Durable, reusable lessons discovered while working in this repo. Appended at
session end by the Stop hook (`.claude/hooks/stop-extract-learn.js`) and
injected at the start of each session by the SessionStart hook
(`.claude/hooks/session-start-learn.js`). Curate freely — this file is meant
to be read and edited by humans too. No secrets or one-off details.

<!-- Add dated headings and concise bullets below. -->

## 2026-07-15 — Remote environment (Claude Code on the web)

- Docker daemon is **not persistent** here — it dies between turns. Restart with `dockerd &` then `docker compose up -d`; named containers and volumes survive, so Postgres/MinIO data is intact (no re-migrate/re-seed needed) — just restart and rerun.
- Outbound GitHub is **scoped to the session's repos**. For out-of-scope repos, `api.github.com`, `codeload` tarballs, and release-asset download URLs return 403 — only `raw.githubusercontent.com` serves individual files. `npx skills add <owner>/<repo>` works cross-scope (fetches via skills.sh); crates.io and the npm registry are unaffected, so `cargo install` / `npm i -g` are viable fallbacks when a GitHub release binary is blocked.
- The **sqz PreToolUse hook can mangle multi-line `git commit -m`** messages containing parens or other shell-special chars (produces an `eval: syntax error`). Use `git commit -F <file>` for any non-trivial commit message.
