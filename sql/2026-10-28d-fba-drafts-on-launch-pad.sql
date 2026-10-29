-- 2026-10-28 Papa Duck: Drafts FBA books live on the Launch Pad box (Send Station retired).
-- 1) week_board: Drafts FBA books (fba_items with no pick) become squares in their box (id = -fba_items.id, src 'drafts').
CREATE OR REPLACE FUNCTION pipeline.week_board()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
with ob as (select distinct batch, box from pipeline.week_picks w where kind='fba' and skipped_at is null
             and exists (select 1 from pipeline.week_picks x where x.kind='fba' and x.batch = w.batch and x.skipped_at is null
                         and (x.cleared_at is null or exists (select 1 from pipeline.fba_items i where i.pick_id = x.id and (i.airtable_dirty or i.airtable_id is null))))),
     db as (select max(batch) b from pipeline.week_picks where kind='donate'),
     vb as (select distinct vendor, box from pipeline.week_picks w where kind='buyback' and skipped_at is null
             and exists (select 1 from pipeline.week_picks x where x.kind='buyback' and x.vendor = w.vendor and x.box = w.box and x.skipped_at is null and x.cleared_at is null))
select jsonb_build_object(
 'printer', (select (value::jsonb)->>'printer' from backup.config where key = 'fba_printer_seen'),
 'printer_age', (select extract(epoch from now() - ((value::jsonb)->>'at')::timestamptz)::int from backup.config where key = 'fba_printer_seen'),
 'boxes', (select coalesce(jsonb_agg(jsonb_build_object('box', ob.box, 'batch', ob.batch,
     'extra', '[]'::jsonb,
     'books', (select coalesce(jsonb_agg(b.j order by b.n),'[]'::jsonb) from (
         select regexp_replace(p.pd,'\D','','g')::int n, jsonb_build_object('id', p.id, 'pd', p.pd, 'title', p.title, 'lb', p.lb, 'price', p.price, 'cond', p.cond,
         'checked', p.checked_at is not null, 'cleared', p.cleared_at is not null, 'clear', p.clear_log, 'clear_state', p.clear_state,
         'sticker', i.status, 'fnsku', i.fnsku, 'error', i.error, 'printed', i.printed_at is not null,
         'at_ok', (i.airtable_id is not null and not i.airtable_dirty),
         'print_pending', (i.print_requested_at is not null and (i.printed_at is null or i.printed_at < i.print_requested_at)), 'print_error', i.print_error) j
         from pipeline.week_picks p left join pipeline.fba_items i on i.pick_id = p.id where p.kind='fba' and p.batch = ob.batch and p.skipped_at is null
         union all
         select coalesce(nullif(regexp_replace(i.pd,'\D','','g'),'')::int, 0), jsonb_build_object('id', -i.id, 'src', 'drafts', 'pd', i.pd, 'title', i.title,
           'lb', pipeline.week_lb(i.pd,null), 'price', i.price, 'cond', i.cond, 'checked', false,
           'cleared', i.printed_at is not null, 'clear', null, 'clear_state', null,
           'sticker', case when i.status in ('ready','error') then i.status else 'working' end, 'fnsku', i.fnsku, 'error', i.error, 'printed', i.printed_at is not null,
           'at_ok', (i.airtable_id is not null and not i.airtable_dirty),
           'print_pending', (i.print_requested_at is not null and (i.printed_at is null or i.printed_at < i.print_requested_at)), 'print_error', i.print_error)
         from pipeline.fba_items i where i.pick_id is null and i.status not in ('removed','removing') and i.box = ob.box) b)
   ) order by ob.batch), '[]'::jsonb) from ob),
 'history', (select coalesce(jsonb_agg(jsonb_build_object('box', b.n, 'opened', b.opened_at, 'shipped', b.shipped_at,
     'books', (select count(*) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed'),
     'printed', (select count(*) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed' and i.printed_at is not null),
     'verified', (select count(*) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed' and i.printed_at is not null and not i.airtable_dirty and i.airtable_id is not null
                   and (i.pick_id is null or exists (select 1 from pipeline.week_picks p where p.id = i.pick_id and p.clear_state = 'ok'))),
     'lb', (select round(sum(coalesce((select lb from pipeline.week_picks p where p.id = i.pick_id), pipeline.week_lb(i.pd,null))),1) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed'),
     'value', (select sum(price) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed')) order by b.n desc), '[]'::jsonb) from pipeline.fba_boxes b),
 'donate', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'pd', p.pd, 'title', p.title, 'lb', p.lb, 'price', p.price,
     'checked', p.checked_at is not null, 'cleared', p.cleared_at is not null, 'clear', p.clear_log, 'clear_state', p.clear_state)
     order by regexp_replace(p.pd,'\D','','g')::int),'[]'::jsonb)
   from pipeline.week_picks p cross join db where p.kind='donate' and p.batch = db.b and p.skipped_at is null),
 'buyback', (select coalesce(jsonb_agg(jsonb_build_object('vendor', vb.vendor, 'box', vb.box,
     'books', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'pd', p.pd, 'title', p.title, 'lb', p.lb, 'price', p.price, 'isbn', p.isbn,
         'offer', p.offer, 'offers', p.offers, 'copies', p.copies, 'keep', p.keep, 'checked', p.checked_at is not null, 'cleared', p.cleared_at is not null, 'clear', p.clear_log, 'clear_state', p.clear_state)
         order by regexp_replace(p.pd,'\D','','g')::int),'[]'::jsonb)
       from pipeline.week_picks p where p.kind='buyback' and p.vendor = vb.vendor and p.box = vb.box and p.skipped_at is null)
   ) order by case vb.vendor when 'World of Books - Sell Your Books' then 1 when 'BooksRun' then 2 else 3 end, vb.box), '[]'::jsonb) from vb),
 'buyback_progress', (select jsonb_build_object('checked', count(*) filter (where status = 200), 'with_offer', count(*) filter (where status = 200 and pipeline.buyback_pick(pd) is not null)) from pipeline.buyback_quotes),
 'listed_isbn', (select count(*) from backup.airtable_records where table_id='tblKxgB4q7v9SPqze' and not coalesce(deleted_in_airtable,false) and fields->>'Status'='Listed'
     and length(regexp_replace(coalesce(fields->>'ISBN',''),'[^0-9Xx]','','g')) in (10,13))
) $function$;

-- 2) Print all also prints the Drafts FBA books in that box
CREATE OR REPLACE FUNCTION pipeline.week_print(p_box integer DEFAULT NULL::integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  update pipeline.fba_items i set print_requested_at = now(), print_error = null, updated_at = now()
   from pipeline.week_picks p where p.id = i.pick_id and p.kind='fba' and p.skipped_at is null and p.cleared_at is null
     and (p_box is null or p.box = p_box) and i.status = 'ready' and i.fnsku is not null and i.printed_at is null;
  update pipeline.fba_items i set print_requested_at = now(), print_error = null, updated_at = now()
   where i.pick_id is null and (p_box is null or i.box = p_box) and i.status = 'ready' and i.fnsku is not null and i.printed_at is null;
  return pipeline.week_board();
end $function$;

-- 3) One Drafts FBA sticker from the Launch Pad
CREATE OR REPLACE FUNCTION pipeline.week_print_draft(p_item bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  perform pipeline.fba_print_request(array[p_item]);
  return pipeline.week_board();
end $function$;

-- 4) Drafts FBA books go to Amazon by themselves (was Send Station's "Send to Amazon FBA" button).
--    A book that still can't go after 20 minutes raises one alert.
CREATE OR REPLACE FUNCTION pipeline.fba_drafts_tick()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare r jsonb; p text; v_pd text;
begin
  if not exists (select 1 from pipeline.drafts where status = 'sent' and built_at is null and channel = 'fba') then return jsonb_build_object('fba', 0); end if;
  r := pipeline.fba_from_blastoff();
  for p in select jsonb_array_elements_text(coalesce(r->'fba_problems','[]'::jsonb)) loop
    v_pd := split_part(p, ':', 1);
    if exists (select 1 from pipeline.drafts where pd = v_pd and status = 'sent' and channel = 'fba' and coalesce(sent_at, updated_at) < now() - interval '20 minutes') then
      perform pipeline.alert_add('Amazon FBA', v_pd || ': could not go to FBA yet', substr(p, length(v_pd) + 3), v_pd, null, 'issue', 'fbadraft:' || v_pd);
    end if;
  end loop;
  return r;
end $function$;
-- cron: pd-fba-drafts */2 * * * * select pipeline.fba_drafts_tick()
