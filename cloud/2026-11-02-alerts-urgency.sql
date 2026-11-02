-- Papa Duck 2026-11-02: every marketplace email on the Launch Pad with an urgency level.
-- kinds: 'urgent' (act today) · 'issue'/'question' (needs you, not urgent) · 'fyi'/'handled' (nothing to do). Urgent sorts first.
create or replace function pipeline.alerts_open() returns jsonb language sql stable security definer set search_path to 'pipeline','pg_catalog' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'source', source, 'kind', kind, 'pd', pd, 'title', title, 'detail', detail, 'link', link, 'at', created_at)
    order by case kind when 'urgent' then 0 when 'issue' then 1 when 'question' then 1 when 'fyi' then 2 else 3 end, created_at desc), '[]'::jsonb)
  from pipeline.alerts where done_at is null $$;
-- The hourly email watch (scheduled task trig_01532433mnT51RWKMxpBcURH) now posts EVERY marketplace / buyback / shipping email with one of these kinds.
