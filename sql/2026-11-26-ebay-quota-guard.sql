-- 2026-11-26 (Thanksgiving night): every Scout scan since 4:58 PM PT came back with no eBay data.
-- Cause: eBay's Browse API daily limit (5,000 calls) was used up - 5,410 calls by evening. Each scan used up to 42 calls
-- (2 searches + up to 40 sold-counter item calls) and the Goodwill re-check ran 2 more scans every minute.
-- Fix (with scout v30):
--   * pipeline.ebay_sold_cache: sold counters are kept 2 days, so the same listing is never looked up twice
--   * pipeline.config ebay_out_until: when eBay says the day's lookups are gone, Scout stops asking until the reset (midnight PT)
--     and books get "YOUR CALL - Maybe later box" instead of a Goodwill call made without eBay
--   * cleanup_piles.recheck->>'ebay_wait': those books are re-checked automatically once eBay is back
--   * goodwill_recheck pauses while eBay is out (it was burning the last calls on bad re-checks)

create table if not exists pipeline.ebay_sold_cache (
  item_id text primary key,
  sold int,
  seller text,
  ship numeric,
  checked_at timestamptz not null default now()
);

-- tonight's Quick-check books (scanned without eBay) wait for a re-check
update pipeline.cleanup_piles set rechecked_at = null,
  recheck = coalesce(recheck, '{}'::jsonb) || jsonb_build_object('ebay_wait', true)
 where created_at > '2026-11-27 00:58:41+00' and batch like 'Station %' and pile_suggested in ('GOODWILL','SELL');

create or replace function pipeline.goodwill_recheck()
 returns integer
 language plpgsql
as $function$
-- 2026-11-09: Papa Duck "since I put the picture in the app and it keeps track of the goodwill seems like you should automatically double check it".
-- Book Station Quick checks that went to the Goodwill pile because NOTHING was found are searched again by title + author.
-- If the second look says LIST, a card goes to the List again box: pull it back.
-- 2026-11-15 "the list again can not be this delayed": runs every MINUTE (was 15), and a book he already re-scanned that landed on
--   another pile (LIST / MAYBE / BASKET ...) is never carded again (The Rosebud I Remember showed twice after he had already listed it).
-- 2026-11-26: pauses while eBay's daily lookups are used up (pipeline.config ebay_out_until), and also re-checks books that were
--   scanned while eBay was out (recheck->>'ebay_wait'), whatever price they got without eBay.
declare x record; r extensions.http_response; j jsonb; n int := 0; outu text; wait boolean;
begin
  insert into pipeline.config(key, value) values ('gw_recheck_last', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI'))
    on conflict (key) do update set value = excluded.value;
  select value into outu from pipeline.config where key = 'ebay_out_until';
  if outu is not null and outu <> '' and now() < outu::timestamptz then return 0; end if;
  -- close any open card whose book was re-scanned onto another pile
  update pipeline.alerts a set done_at = now() from pipeline.cleanup_piles p
   where a.source = 'Goodwill check' and a.done_at is null and a.link = 'pile:' || p.id
     and exists (select 1 from pipeline.cleanup_piles q where q.id <> p.id and lower(q.title) = lower(p.title) and q.pile <> 'GOODWILL' and q.created_at > p.created_at);
  for x in select * from pipeline.cleanup_piles p
           where batch like 'Station %' and rechecked_at is null and created_at > now() - interval '3 days' and coalesce(title,'') <> ''
             and ((pile = 'GOODWILL' and pile_suggested in ('GOODWILL','SELL') and list_price is null)
                  or (recheck->>'ebay_wait' = 'true' and pile in ('GOODWILL','SELL','CHECK','MAYBE')))
             and not exists (select 1 from pipeline.cleanup_piles q where q.id <> p.id and lower(q.title) = lower(p.title) and q.pile not in ('GOODWILL','CHECK') and q.created_at > p.created_at)
           order by id limit 2 loop
    wait := coalesce(x.recheck->>'ebay_wait' = 'true', false);
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '25000');
    begin
      r := extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scout', array[]::extensions.http_header[], 'application/json',
            jsonb_build_object('pin', (select value from backup.config where key = 'scout_pin'), 'action', 'evaluate', 'mode', 'cleanup',
              'ident', jsonb_build_object('kind','book','title', x.title, 'author', coalesce(x.author,''), 'isbn', coalesce(x.isbn,''), 'confidence','medium'))::text)::extensions.http_request);
      j := r.content::jsonb;
    exception when others then j := jsonb_build_object('error', left(sqlerrm, 200));
    end;
    -- eBay ran out again mid-check: leave it waiting, the pause above stops the loop until midnight
    if coalesce(j->>'reason','') like '⏳%' then continue; end if;
    update pipeline.cleanup_piles set rechecked_at = now(),
      recheck = jsonb_build_object('verdict', j->>'verdict', 'list', j->'list', 'reason', j->>'reason', 'error', j->>'error', 'ebay_wait_done', wait) where id = x.id;
    if j->>'verdict' = 'LIST' then
      perform pipeline.alert_add('Goodwill check', left(x.title, 70),
        case when wait then 'This was scanned while eBay was down, so it got no eBay prices. With eBay back: ' || coalesce(j->>'reason','')
             else 'The Quick check couldn''t find this one from the photo, so it went to Goodwill. A second look by title found it: ' || coalesce(j->>'reason','') end ||
        E'\nIf you already know it''s damaged, used up, or not family-friendly, leave it in Goodwill.', null, 'pile:' || x.id, 'need', 'gw-recheck:' || x.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $function$;

-- tonight: eBay's own rate-limit report said 5,410 of 5,000 used, reset 2026-11-27 08:00 UTC (midnight PT)
insert into pipeline.config(key, value) values ('ebay_out_until', '2026-11-27T08:00:00Z')
  on conflict (key) do update set value = excluded.value;
