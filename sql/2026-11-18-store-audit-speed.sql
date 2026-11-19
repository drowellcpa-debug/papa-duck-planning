-- 2026-11-18 22:05 Papa Duck: "the store audit just keeps saying loading?"
-- audit.report_full() took over 60 s: in the 'qty' part the planner inlined the Airtable CTE and re-scanned
-- backup.airtable_records for every store row. Both CTEs are now MATERIALIZED -> the whole report runs in about 1 s.
CREATE OR REPLACE FUNCTION audit.report_full()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select audit.report() || jsonb_build_object(
    'old', (select jsonb_agg(jsonb_build_object('pd', o.pd, 'title', o.title, 'sold_day', o.sold_day, 'sold_on', o.sold_on, 'why', o.why, 'closed', o.closed_at,
              'live_now', (select string_agg(store, ', ') from audit.live l where l.pd = o.pd)) order by o.sold_day nulls last, o.pd) from audit.old_closeout o),
    'unknown_ebay', (select jsonb_agg(jsonb_build_object('item', ref, 'title', title) order by title) from audit.live where store = 'eBay' and coalesce(pd,'') = ''),
    'ext_sales', (select jsonb_agg(jsonb_build_object('channel', s.channel, 'pd', s.pd, 'day', s.day, 'title', s.title,
              'live_now', (select string_agg(store, ', ') from audit.live l where l.pd = s.pd)) order by s.day desc) from audit.sold_ext s),
    'qty', (with at as materialized (select upper(r.fields->>'Tracking Number') pd, r.fields->>'Status' st, coalesce(nullif(r.fields->>'Quantity','')::int,1) q, left(r.fields->>'Title',60) t
                         from backup.airtable_records r where r.table_id='tblKxgB4q7v9SPqze'),
                 l as materialized (select pd, store, sum(qty) qty from audit.live where pd <> '' and store <> 'Amazon' group by 1,2)
            select jsonb_agg(jsonb_build_object('pd', pd, 'title', t, 'airtable', q, 'stores', stores) order by pd) from (
              select l.pd, at.t, at.q, string_agg(l.store || ' ' || l.qty, ', ' order by l.store) stores from l join at on at.pd = l.pd
              where at.st = 'Listed' group by l.pd, at.t, at.q having max(l.qty) > at.q) z));
$function$;
