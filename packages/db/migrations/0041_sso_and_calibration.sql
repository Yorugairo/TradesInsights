-- OTN → Insights sign-in handoff, and calibration provenance on the cockpit.
--
-- 1. `sso_consumed` — the single-use ledger for the handoff token.
--
-- The token is stateless (HMAC-signed claims, 60-second life). This table
-- exists only so one cannot be replayed: the INSERT is the claim, and a unique
-- violation IS the refusal. That is race-free in a way read-then-write is not,
-- mirroring the atomic `UPDATE … WHERE used_at IS NULL` claim in
-- `packages/delivery/src/actions.ts`.
--
-- It is a NEW table rather than a reuse of `action_tokens` because that table
-- structurally cannot hold an SSO row: `opportunity_id` is NOT NULL and
-- migration 0019 CHECK-pins `action` to 'pursue' | 'dismiss'.
--
-- Rows are pruned opportunistically by the SSO route (tokens live 60 seconds,
-- so a day of history is already generous) — no maintenance-chain step.

CREATE TABLE IF NOT EXISTS sso_consumed (
  jti text PRIMARY KEY,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- 2. `account_profiles.calibration_json` — calibration provenance, stamped by
-- the seed from `config/account-profiles.yaml`:
--   {owner_assumed: string[], calibration_pending: string[]}
--
-- `owner_assumed` are settings the OWNER set from relationship knowledge and
-- the customer has never confirmed — live in scoring today, carrying no
-- customer mandate. `calibration_pending` are genuinely unknown. The cockpit
-- shows both so a provisional number is never read as a settled one.
--
-- NULLABLE on purpose: NULL = "the seed has not stamped this account", which
-- is a different fact from "no assumptions remain" (empty arrays). The cockpit
-- renders those as different states.
--
-- WHY A COLUMN and not a yaml read: `apps/web` never loads `@otn/config` at
-- runtime, and the hosted deploy is not guaranteed to ship the config
-- directory — a card that works locally and shows nothing in production would
-- be worse than no card at all.

ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS calibration_json jsonb;
