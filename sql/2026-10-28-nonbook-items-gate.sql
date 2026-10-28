-- 2026-10-28 Non-book items (cups, jewelry, village houses, games). Books are untouched:
-- only a Station draft with NO isbn, NO author and a non-book format waits for the item check (6 of the last 633 drafts, all non-books).
alter table pipeline.drafts add column if not exists item_stale boolean not null default false;
create or replace function pipeline.drafts_item_gate() returns trigger language plpgsql as $$
begin
  if new.built_at is null and new.ident is not null and coalesce(new.ident->>'title','') <> '' then
    if new.ident->>'kind' = 'item' then
      if new.price_stale then new.price_stale := false; new.item_stale := true; end if;
    elsif new.price_stale and new.source = 'station' and new.ident->>'item_check' is null
      and coalesce(new.ident->>'isbn','') = '' and coalesce(new.ident->>'author','') = ''
      and lower(coalesce(new.ident->>'format','')) !~ '(paper|hard|spiral)' then
      new.price_stale := false;
      new.ident := new.ident || jsonb_build_object('item_check', 'pending', 'item_check_at', now());
    end if;
  end if;
  return new;
end $$;
drop trigger if exists drafts_item_gate on pipeline.drafts;
create trigger drafts_item_gate before insert or update on pipeline.drafts for each row execute function pipeline.drafts_item_gate();
create or replace function pipeline.items_release_stuck() returns int language sql as $$
  with u as (update pipeline.drafts set ident = ident || '{"item_check":"book","item_check_note":"timed out - priced as a book"}'::jsonb, price_stale = true
    where ident->>'item_check' = 'pending' and (ident->>'item_check_at')::timestamptz < now() - interval '6 minutes' returning 1)
  select count(*)::int from u $$;
-- cron pd-items-worker (every minute): select pipeline.items_release_stuck(); then POST items-worker when an item check or item price is waiting.
