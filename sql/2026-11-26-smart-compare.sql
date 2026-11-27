-- 2026-11-26 night: side-by-side test of scout v31 SMART LOOKUPS vs the old way, on 30 of tonight's Quick-check books,
-- right after eBay's daily lookups reset (midnight PT = 08:00 UTC). Papa Duck: "Yes" to the side-by-side test before switching it on.
-- Smart runs first (so its lookup count is real); the old way's count is shown as eBay would have charged it: 2 searches + 1 per copy checked (max 25).
create table if not exists pipeline.smart_compare (
  id bigserial primary key, pile_id bigint, title text,
  new_verdict text, new_list numeric, new_calls int, new_secs int,
  old_verdict text, old_list numeric, old_calls_est int, old_secs int,
  at timestamptz default now());

create or replace function pipeline.smart_compare_step()
 returns int
 language plpgsql
as $function$
declare x record; r extensions.http_response; jn jsonb; jo jsonb; n int := 0; pin text; idj jsonb;
begin
  if now() < '2026-11-27 08:01:00+00' then return 0; end if;
  if (select count(*) from pipeline.smart_compare) >= 30 then
    perform cron.unschedule('pd-smart-compare'); return 0;
  end if;
  select value into pin from backup.config where key = 'scout_pin';
  for x in select distinct on (lower(p.title)) p.id, p.title, p.author, p.isbn from pipeline.cleanup_piles p
            where p.created_at > '2026-11-27 00:58:41+00' and p.created_at < '2026-11-27 08:00:00+00' and p.batch like 'Station %' and coalesce(p.title,'') <> ''
              and not exists (select 1 from pipeline.smart_compare c where lower(c.title) = lower(p.title))
            order by lower(p.title), p.id limit 1 loop
    idj := jsonb_build_object('kind','book','title', x.title, 'author', coalesce(x.author,''), 'isbn', coalesce(x.isbn,''), 'confidence','medium');
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '28000');
    begin
      r := extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scout', array[]::extensions.http_header[], 'application/json',
        jsonb_build_object('pin', pin, 'action', 'evaluate', 'mode', 'cleanup', 'smart', true, 'ident', idj)::text)::extensions.http_request);
      jn := r.content::jsonb;
    exception when others then jn := jsonb_build_object('error', left(sqlerrm, 200)); end;
    begin
      r := extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scout', array[]::extensions.http_header[], 'application/json',
        jsonb_build_object('pin', pin, 'action', 'evaluate', 'mode', 'cleanup', 'smart', false, 'ident', idj)::text)::extensions.http_request);
      jo := r.content::jsonb;
    exception when others then jo := jsonb_build_object('error', left(sqlerrm, 200)); end;
    insert into pipeline.smart_compare (pile_id, title, new_verdict, new_list, new_calls, new_secs, old_verdict, old_list, old_calls_est, old_secs)
    values (x.id, x.title, coalesce(jn->>'verdict', 'ERR: ' || (jn->>'error')), nullif(jn->>'list','')::numeric, (jn->>'ebay_calls')::int, (jn->>'secs')::int,
            coalesce(jo->>'verdict', 'ERR: ' || (jo->>'error')), nullif(jo->>'list','')::numeric,
            case when jo ? 'activeN' then 2 + least(25, (jo->>'activeN')::int) end, (jo->>'secs')::int);
    n := n + 1;
  end loop;
  return n;
end $function$;

select cron.schedule('pd-smart-compare', '* * * * *', 'select pipeline.smart_compare_step()');
