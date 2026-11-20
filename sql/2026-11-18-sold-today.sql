-- 2026-11-18 22:10 Papa Duck: "on the top right of my launge pad where hte check a find, take that off since you have the vinted app and add the
--   daily book autit there that on a grid shows me the book sold and then removed for today, then it goes to the audit report the next day and
--   starts over, make it clean and clear". Card "✅ Sold today" (launchpad-v1.html, renderSold) reads this; drafts-api v6 allows it.
create or replace function pipeline.sold_today() returns jsonb
language sql stable security definer set search_path to 'pipeline', 'pg_catalog' as $f$
  with t as (select (now() at time zone 'America/Los_Angeles')::date today),
  s as (
    select sd.key, upper(sd.info->>'pd') pd, left(coalesce(sd.info->>'title', ''), 70) title, split_part(sd.key, ':', 1) ch,
           (sd.info->>'price')::numeric price, sd.at, sd.info->'st' st
      from pipeline.sales_done sd, t
     where coalesce(nullif(sd.info->>'date','')::date, (sd.at at time zone 'America/Los_Angeles')::date) = t.today
       and not exists (select 1 from pipeline.ship_marks m where m.key = sd.key and m.kind = 'cancelled'))
  select jsonb_build_object('today', (select today from t),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('pd', pd, 'title', title, 'ch', ch, 'price', price,
              'time', to_char(at at time zone 'America/Los_Angeles', 'FMHH12:MI AM'),
              'ebay', st->>'ebay', 'abe', st->>'abe', 'etsy', st->>'etsy', 'amazon', st->>'amazon', 'airtable', st->>'airtable') order by at desc) from s), '[]'::jsonb))
$f$;

-- Store audit: a returned book he sent back out is supposed to be live again (PD-3190 Chilton showed as "sold but still on eBay").
-- audit.report() 'conf' CASE got, right after its first WHEN:
--   when exists (select 1 from pipeline.drafts dr where upper(dr.pd) = l.pd and dr.answers ? 'relist') then null
-- PD-3190 went out through the mini launch (not relist_return), so its marker was added by hand:
update pipeline.drafts set answers = answers || '{"relist":"2026-11-17"}'::jsonb where id = 318;

-- 2026-11-19 20:54: audit.report() 'since_oct7' still_ok also counts a relisted return as fine (PD-3190 showed "Sold 2026-10-12 on amazon,
-- still on eBay"). Added at the start of still_ok:
--   exists (select 1 from pipeline.drafts dr where upper(dr.pd) = upper(s.info->>'pd') and dr.answers ? 'relist') or ...
-- PD-0249 plates: the 11/19 buyer took the last 4 ($91.96) - the flags were from the 11/18 store scan; a fresh scan shows them gone.
