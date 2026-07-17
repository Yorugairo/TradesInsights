-- Security review (P2.3): defense-in-depth constraints on action_tokens —
-- the action enum is enforced in the DB, not just application code.
ALTER TABLE action_tokens
  ADD CONSTRAINT action_tokens_action_check CHECK (action IN ('pursue', 'dismiss'));
ALTER TABLE action_tokens
  ADD CONSTRAINT action_tokens_used_after_created CHECK (used_at IS NULL OR used_at >= created_at);
