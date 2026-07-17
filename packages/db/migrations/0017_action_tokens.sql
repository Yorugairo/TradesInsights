-- P2.3 — one-tap email actions. A token authorizes exactly ONE action on ONE
-- opportunity for ONE account, expires, and is single-use. Only the SHA-256
-- of the token is stored — a database read never yields a usable link.
CREATE TABLE action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  account_profile_id uuid NOT NULL REFERENCES account_profiles(id),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  delivery_id uuid REFERENCES deliveries(id),
  action text NOT NULL, -- pursue | dismiss
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_tokens_delivery_ix ON action_tokens (delivery_id);
