-- 2026-11-25 Papa Duck: "When the vinted books come I will want to add them to the book station and get the price/descriptions ready
--   and then when you tell me to list them and the books are ready in that red urgent I can click list please and it will list them"
--   + "they will need repriced often to make sure they match the keepa trend and current trend - without bogging our system down"
-- 1) A Duck Hunter buy photographed in the Book Station is matched by ISBN -> its draft goes to the Hold Shelf (out of blast off)
--    and the hold remembers its PD / draft.
-- 2) pipeline.hold_list_now(hold id) - the 📚 List it now button: re-prices it from today's market and releases it into the next
--    blast off.
-- 3) The price watch runs every morning (one Keepa call per 20 books, held Vinted books only) instead of once a week.
alter table hunter.holds add column if not exists pd text, add column if not exists draft_id bigint;

create or replace function pipeline.drafts_hold_match() returns trigger
language plpgsql security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
declare h record; k text;
begin
  if new.built_at is not null then return new; end if;
  k := pipeline.isbn13(coalesce(new.ident->>'isbn', ''));
  if coalesce(k, '') = '' then return new; end if;
  if exists (select 1 from hunter.holds where draft_id = new.id) then return new; end if;   -- already linked
  select * into h from hunter.holds where pipeline.isbn13(coalesce(isbn, '')) = k and draft_id is null and status in ('holding', 'ready')
   order by created_at limit 1;
  if not found then return new; end if;
  update hunter.holds set draft_id = new.id, pd = new.pd where id = h.id;
  if h.status = 'holding' then
    new.location := 'Hold Shelf';
    new.answers := coalesce(new.answers, '{}'::jsonb) || jsonb_build_object('hunter_hold', h.id);
    new.flags := coalesce(new.flags, '[]'::jsonb) || to_jsonb(array['🦆 Vinted buy (Duck Hunter) - waiting for its season' ||
      coalesce(' (' || h.season_month || ')', '') || '. It stays on the Hold Shelf and out of blast off until its urgent note says List it now.']);
  else
    new.answers := coalesce(new.answers, '{}'::jsonb) || jsonb_build_object('hunter_hold', h.id);
  end if;
  return new;
end $f$;
drop trigger if exists drafts_hold_match on pipeline.drafts;
create trigger drafts_hold_match before insert or update of ident on pipeline.drafts for each row execute function pipeline.drafts_hold_match();

create or replace function pipeline.hold_list_now(p_id bigint) returns jsonb
language plpgsql security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
declare h record; d record; cur numeric; want numeric;
begin
  select * into h from hunter.holds where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if h.draft_id is null then
    select * into d from pipeline.drafts where pipeline.isbn13(coalesce(ident->>'isbn','')) = pipeline.isbn13(coalesce(h.isbn,'')) and built_at is null order by id desc limit 1;
    if not found then return jsonb_build_object('ok', false, 'error', 'Photograph this book in the Book Station first - then tap List it now'); end if;
    update hunter.holds set draft_id = d.id, pd = d.pd where id = h.id;
  else
    select * into d from pipeline.drafts where id = h.draft_id;
  end if;
  if d.built_at is not null then
    update hunter.holds set status = 'listed' where id = h.id;
    return jsonb_build_object('ok', true, 'pd', d.pd, 'note', 'Already listed');
  end if;
  -- today's price: the higher of its draft price and today's market (Amazon used now, eBay suggestion) - never below the draft price
  cur := coalesce(d.price_override, (d.pricing->>'list')::numeric);
  want := greatest(coalesce(cur, 0), coalesce(h.now_price, 0), coalesce(case when abs(coalesce(h.list_price,0) - coalesce(h.target,0)) > 0.01 then h.list_price end, 0));
  if want > 0 then want := ceil(want) - 0.01; end if;
  update pipeline.drafts set answers = coalesce(answers, '{}'::jsonb) || jsonb_build_object('bd', coalesce(answers->'bd', '{}'::jsonb) || '{"release":"yes"}'::jsonb),
         price_override = case when want > 0 and want <> coalesce(cur, 0) then want else price_override end
   where id = d.id;
  update hunter.holds set status = 'listed' where id = h.id;      -- closes its urgent note (trigger)
  return jsonb_build_object('ok', true, 'pd', d.pd, 'price', want, 'was', cur, 'status', d.status,
    'note', case when d.status = 'sent' then 'Goes out in tonight''s blast off' else 'Open it in Drafts and tap Send - then it goes in the next blast off' end);
end $f$;

-- the morning watch: every day 7:17 AM PT (was Mondays only). One Keepa call per 20 held books; nothing is pushed to any store.
select cron.schedule('pd-hold-watch', '17 15 * * *', 'select pipeline.hold_check()');
