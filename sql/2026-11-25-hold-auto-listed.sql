-- 2026-11-25 Papa Duck: "on the holding for season can you auto remove it if I did send it up to the cloud launch,
--   life of fred is still showing to holding for season"
-- When a held book's draft is picked up at blast off (built_at set), its hold is marked listed (that also closes its urgent alert),
-- and the 🦆 Holding for the season card no longer shows listed books at all.
create or replace function pipeline.drafts_hold_listed() returns trigger
language plpgsql security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
begin
  if new.built_at is not null and old.built_at is null then
    update hunter.holds set status = 'listed', ready_at = coalesce(ready_at, now()),
           list_price = coalesce(new.price_override, (new.pricing->>'list')::numeric, list_price)
     where draft_id = new.id and status in ('holding', 'ready');
  end if;
  return new;
end $f$;
drop trigger if exists drafts_hold_listed on pipeline.drafts;
create trigger drafts_hold_listed after update of built_at on pipeline.drafts for each row execute function pipeline.drafts_hold_listed();

create or replace function pipeline.hold_board() returns jsonb
language sql stable security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'title', left(h.title, 70), 'isbn', h.isbn, 'cost', h.cost, 'target', h.target,
              'month', h.season_month, 'status', h.status, 'now', h.now_price, 'checked', h.checked_at, 'ready_at', h.ready_at,
              'bought', h.created_at, 'store', h.best_store, 'note', h.season->>'note', 'pd', h.pd, 'draft_id', h.draft_id)
            order by (h.status = 'ready') desc, h.created_at) from hunter.holds h
         where h.status in ('holding', 'ready')), '[]'::jsonb),
    'last_check', (select max(checked_at) from hunter.holds))
$f$;

-- catch up: books already picked up at blast off (Life of Fred PD-0346, night L56)
update hunter.holds h set status = 'listed', ready_at = coalesce(h.ready_at, now())
  from pipeline.drafts d where d.id = h.draft_id and d.built_at is not null and h.status in ('holding', 'ready');
