-- Idempotency for field entries, so an offline crew submission can be retried
-- without duplicating the row.
--
-- WHY THIS IS REQUIRED, not a nicety: `addFieldEntry` INSERTs unconditionally.
-- The mobile outbox replays a queued entry on every reconnect trigger until it
-- sees a 2xx, and any retry that crosses a response it never received (dropped
-- connection, backgrounded tab, 429 held mid-flush) would write the day's log
-- twice. "Exactly once", which the mobile PRD lists as an acceptance criterion,
-- is unimplementable without a key.
--
-- CLIENT-MINTED KEY. The id comes from the device, not the server, because only
-- the client knows that two POSTs are the same INTENT. A server-side dedupe
-- would have to infer it from content — and two identical daily logs on two
-- different days are both real work. Deduping on a content hash would silently
-- delete a crew's Tuesday.
--
-- NULLABLE + PARTIAL UNIQUE. Cockpit-authored entries (link_id IS NULL, written
-- from the office UI) send no client id and must stay unaffected. NULLs do not
-- collide in a partial unique index, so their behaviour is byte-identical to
-- before this migration.
--
-- The index is UNIQUE across the whole table rather than per-pursuit: the value
-- is a UUIDv4 minted per queued entry, so global uniqueness is already implied,
-- and a narrower key would let a replay aimed at the wrong pursuit slip through
-- as a fresh row.

ALTER TABLE field_entries ADD COLUMN IF NOT EXISTS client_entry_id text;

CREATE UNIQUE INDEX IF NOT EXISTS field_entries_client_entry_ux
  ON field_entries (client_entry_id)
  WHERE client_entry_id IS NOT NULL;
