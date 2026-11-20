-- 2026-11-20 13:33 Papa Duck: "It is not showing on launch pad" (Pathway Reader: Our Heritage Grade 8, eBay order 11-15453-74107, $12.32 -
-- a hand-made eBay listing with no PD number; sales-cloud logged it as "no PD number - emailed" without the 'st' block, so To ship skipped it).
CREATE OR REPLACE FUNCTION pipeline.to_ship()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'pd', coalesce(s.info->>'pd', 'No PD #'), 'title', s.info->>'title',
      'channel', coalesce(s.info->>'channel', split_part(s.key, ':', 1)),
      'date', coalesce(s.info->>'date', to_char(s.at at time zone 'America/Los_Angeles', 'YYYY-MM-DD')), 'price', (s.info->>'price')::numeric,
      'order', s.info->>'order', 'cover', s.info->>'cover',
      'bin', case when f.fba then null else (select x.bin from pipeline.drafts x where upper(x.pd) = upper(s.info->>'pd') and x.bin is not null order by x.id desc limit 1) end,
      'fba', f.fba, 'at', s.at) order by s.at desc), '[]'::jsonb)
  from pipeline.sales_done s
  cross join lateral (select (s.info->>'channel' = 'amazon' and pipeline.is_fba_pd(s.info->>'pd')) as fba) f
  where (s.info ? 'st' or coalesce(s.info->>'note', '') like 'no PD number%') and s.at > now() - interval '14 days'
    and not exists (select 1 from pipeline.ship_marks m where m.key = s.key)
    and (not coalesce(f.fba, false) or s.info->>'date' = to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'))
$function$;
