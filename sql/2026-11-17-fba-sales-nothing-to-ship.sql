-- 2026-11-17 Papa Duck: "these need to go to show sold Amazon FBA and nothing to ship, but is in my totals and on the sale
--   for that day and go away automatically for the next days new sales".
-- An Amazon sale whose PD is in an FBA box that went to Amazon = FBA (Amazon ships it).
-- To ship: FBA sales show ONLY on the day they sold (Pacific), flagged fba=true (no Shipped button), then drop off.
-- Totals: sales_board already counts every sales_done row (nothing changes there).

create or replace function pipeline.is_fba_pd(p_pd text) returns boolean language sql stable as $$
  select exists (select 1 from pipeline.fba_items i join pipeline.fba_ship s on s.box = i.box
                 where upper(i.pd) = upper(p_pd) and s.label_at is not null and i.status not in ('removed','removing'))
$$;

create or replace function pipeline.to_ship() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', s.key, 'pd', s.info->>'pd', 'title', s.info->>'title', 'channel', s.info->>'channel',
      'date', s.info->>'date', 'price', (s.info->>'price')::numeric, 'order', s.info->>'order', 'cover', s.info->>'cover',
      'bin', case when f.fba then null else (select x.bin from pipeline.drafts x where upper(x.pd) = upper(s.info->>'pd') and x.bin is not null order by x.id desc limit 1) end,
      'fba', f.fba, 'at', s.at) order by s.at desc), '[]'::jsonb)
  from pipeline.sales_done s
  cross join lateral (select (s.info->>'channel' = 'amazon' and pipeline.is_fba_pd(s.info->>'pd')) as fba) f
  where s.info ? 'st' and s.at > now() - interval '14 days' and not exists (select 1 from pipeline.ship_marks m where m.key = s.key)
    and (not f.fba or s.info->>'date' = to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'))
$$;
