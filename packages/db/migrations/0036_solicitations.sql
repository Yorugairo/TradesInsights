-- The SECOND record class: bids get their own table (owner decision,
-- 2026-07-27), carried through the SAME source pipeline.
--
-- WHY NOT `source_records`. A solicitation disagrees with a permit on every
-- structural axis: `county` is required + enum-constrained on the permit
-- record and routinely ABSENT here (statewide procurement has no county);
-- there is no column anywhere for a bid DEADLINE, which is the single field a
-- solicitation exists to publish; and a bid ends in a WINNER, which the permit
-- lifecycle has nowhere to record. Two of the event types that already exist in
-- `taxonomy.ts` — `bid_deadline_changed` and `award_published` — can never fire
-- in the permit model because there is no typed deadline to diff and no field
-- for an awardee.
--
-- The decisive case is a real WEBS row: "Maintenance and Service of Gas
-- Chromatography Laboratory Equipment — WSP-RFQQ-GasChro3". No parcel, no
-- building, no jurisdiction, no county. Pushed through the permit shape it
-- injects non-construction procurement into the project graph.
--
-- Everything expensive is still shared: discover/fetch, fetch policy and rate
-- limiting, the artifact store, replay, backfill, the `source_runs` lifecycle
-- and its counters, health, orphan reaping, config and alerting. This table and
-- one persist branch in `runner.ts` are the entire cost of the second class.

CREATE TABLE IF NOT EXISTS solicitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id),
  -- Mirrors source_records: the artifact these bytes were parsed from, so
  -- every field stays traceable to immutable storage.
  raw_artifact_id uuid NOT NULL REFERENCES raw_artifacts(id),
  external_id text NOT NULL,

  solicitation_number text,
  title text NOT NULL,
  description text,
  -- WEBS: the procuring agency. OMWBE: the agency, or the prime running the
  -- sub-bid call. The solicitation's analogue of permitting_jurisdiction.
  procuring_agency text NOT NULL,
  -- Set only for "SUB-BIDS REQUESTED" posts.
  prime_contractor text,
  -- 'solicitation' | 'sub_bid_request'. The sub-bid class is the
  -- differentiated signal (the only public window into GC bid boards that
  -- otherwise live behind BuildingConnected invitation lists), so it is a
  -- COLUMN and not a substring of the title.
  document_type text NOT NULL,

  -- FIRST CLASS, and the reason this table exists. Nullable because OMWBE
  -- listings are third-party submissions with genuinely missing dates and
  -- emitting the row beats skipping it or inventing a date — but typed, so the
  -- deadline can be filtered, sorted, indexed, and DIFFED.
  bid_due_at timestamptz,
  issued_at timestamptz,
  -- 'open' | 'amended' | 'closed' | 'awarded'. Bids have their own lifecycle;
  -- this is not the permit stage ladder.
  status text NOT NULL,

  -- Free text, NOT the permit county enum, and NULL is a CORRECT value rather
  -- than a missing one. Constraining this to the enum would force adapters to
  -- skip every statewide or out-of-coverage record, which is precisely the
  -- blocker this record class dissolves.
  county text,
  city text,
  scope_raw text,
  trade_tags text[] NOT NULL DEFAULT '{}',

  source_url text NOT NULL,
  organizations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_fields_json jsonb NOT NULL,
  normalized_json jsonb NOT NULL,
  -- Same upsert protocol as source_records: fingerprint equal => duplicate
  -- (touch last_seen_at only); fingerprint changed => a real amendment.
  normalized_fingerprint text NOT NULL,

  -- Resolution-time linkage, set ONLY when evidence links the bid to a project
  -- the graph already knows. Null for most WEBS rows and that is the correct
  -- outcome — the value is in the minority that DO link, giving
  -- permit -> solicitation -> award as one thread.
  project_id uuid REFERENCES projects(id),

  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- THE DEDUPE KEY, and it deliberately EXCLUDES observed_at — which inverts the
-- lesson from 0035_project_events_unique, so the reasoning is recorded rather
-- than assumed.
--
-- There, `observed_at` HAD to be in the key: `applyRecordUpdates` legitimately
-- re-emits an event when a record's content drifts, and 136 real re-emits would
-- have been destroyed as duplicates without it. An event is an append-only
-- observation, so a second one is new information.
--
-- A solicitation is the opposite: a MUTABLE row. An amended bid is the SAME
-- solicitation with a later deadline, not a second one. Keying on observed_at
-- would create a new row every single run, which is the failure mode 0035 was
-- fixing, only worse. The amendment history belongs in project_events
-- (bid_addendum / bid_deadline_changed), which is append-only and already keyed
-- correctly.
CREATE UNIQUE INDEX IF NOT EXISTS solicitations_external_ux
  ON solicitations (source_id, external_id);

-- The deadline is the primary query axis for this class ("what closes this
-- week"), so it gets its own index. NULLS LAST matches how it is read: dated
-- bids first, undated stragglers after.
CREATE INDEX IF NOT EXISTS solicitations_bid_due_ix
  ON solicitations (bid_due_at DESC NULLS LAST);

-- Sub-bid requests are queried as a class of their own.
CREATE INDEX IF NOT EXISTS solicitations_document_type_ix
  ON solicitations (document_type, status);

CREATE INDEX IF NOT EXISTS solicitations_project_ix
  ON solicitations (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS solicitations_last_seen_ix
  ON solicitations (last_seen_at);
