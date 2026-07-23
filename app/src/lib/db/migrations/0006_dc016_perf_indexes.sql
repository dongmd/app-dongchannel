-- DC-016 performance hardening — hand-written migration (không sinh từ Drizzle
-- vì tsvector expression index không nằm trong schema TS).
--
-- Bao gồm:
--   1. GIN indexes cho FTS (7 entity của DC-013 unified search)
--   2. B-tree indexes cho hot query paths (list/filter/join)
-- Idempotent: dùng IF NOT EXISTS.

-- ─── FTS GIN indexes ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS tasks_search_gin
  ON tasks USING GIN (to_tsvector('simple', coalesce(title, '')));

CREATE INDEX IF NOT EXISTS memory_entries_search_gin
  ON memory_entries USING GIN (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  );

CREATE INDEX IF NOT EXISTS offers_search_gin
  ON offers USING GIN (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(notes, ''))
  );

CREATE INDEX IF NOT EXISTS videos_search_gin
  ON videos USING GIN (
    to_tsvector('simple',
      coalesce(working_title, '') || ' ' ||
      coalesce(title, '') || ' ' ||
      coalesce(hook, '') || ' ' ||
      coalesce(outline, '')
    )
  );

CREATE INDEX IF NOT EXISTS niches_search_gin
  ON niches USING GIN (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(positioning, ''))
  );

CREATE INDEX IF NOT EXISTS markets_search_gin
  ON markets USING GIN (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(summary, ''))
  );

CREATE INDEX IF NOT EXISTS hermes_messages_search_gin
  ON hermes_messages USING GIN (
    to_tsvector('simple', coalesce(content, ''))
  );

-- ─── Hot query B-tree indexes ─────────────────────────────────────
-- Task list filters
CREATE INDEX IF NOT EXISTS tasks_profile_status_idx
  ON tasks (profile_slug, status);
CREATE INDEX IF NOT EXISTS tasks_updated_at_desc_idx
  ON tasks (updated_at DESC, id DESC);

-- Memory list filters
CREATE INDEX IF NOT EXISTS memory_scope_status_idx
  ON memory_entries (profile_scope, status);
CREATE INDEX IF NOT EXISTS memory_created_desc_idx
  ON memory_entries (created_at DESC);

-- Offer status filter
CREATE INDEX IF NOT EXISTS offers_status_idx
  ON offers (status);

-- Video status filter + FK lookup
CREATE INDEX IF NOT EXISTS videos_status_idx
  ON videos (status);
CREATE INDEX IF NOT EXISTS videos_niche_idx
  ON videos (niche_id) WHERE niche_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS videos_offer_idx
  ON videos (offer_id) WHERE offer_id IS NOT NULL;

-- Task source session FK (dùng khi ingest check trùng)
CREATE INDEX IF NOT EXISTS tasks_source_session_idx
  ON tasks (source_hermes_session_id) WHERE source_hermes_session_id IS NOT NULL;

-- Audit event actor + created_at cho query "recent activity"
CREATE INDEX IF NOT EXISTS audit_events_actor_created_idx
  ON audit_events (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (entity_type, entity_id) WHERE entity_id IS NOT NULL;
