-- 2026-11-22 Papa Duck: "I need the ability to grab an old Pd# and add additional quanity" ... "how do I know the condition we listed before?"
-- Launch Pad ➕ Add copies: qty_lookup (from the hourly Airtable backup - shows title, CONDITION, copies, price, cover),
-- qty_add (starts qty-set v5 with {pd, add, job}), qty_adds_recent (last 5 results). drafts-api v8 allows the three calls.
create table if not exists pipeline.qty_adds (
  id bigserial primary key, pd text not null, add_n int not null, before_qty int, condition text, title text,
  status text not null default 'sending', result jsonb, created_at timestamptz not null default now(), done_at timestamptz);

CREATE OR REPLACE FUNCTION pipeline.qty_lookup(p_pd text) RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pipeline', 'pg_catalog' AS $function$
  with k as (select 'PD-' || substring(upper(coalesce(p_pd,'')) from '(\d{3,5}[A-Z]?)') pd),
  r as (select a.fields f, a.last_seen from backup.airtable_records a, k
        where a.table_id = 'tblKxgB4q7v9SPqze' and not coalesce(a.deleted_in_airtable, false) and upper(a.fields->>'Tracking Number') = k.pd
        order by a.last_seen desc limit 1)
  select case when not exists (select 1 from r) then jsonb_build_object('ok', false, 'error', (select pd from k) || ' is not in your inventory (it may have sold out and moved to Sold).')
    else (select jsonb_build_object('ok', true, 'pd', (select pd from k), 'title', f->>'Title', 'condition', f->>'Condition', 'qty', coalesce((f->>'Quantity')::int, 1),
      'price', f->>'Listed Price', 'status', f->>'Status', 'ebay', f->>'eBay ItemID', 'etsy', f->>'Etsy ListingID', 'cost', f->>'Cost', 'source', f->>'Source',
      'cover', split_part(coalesce(f->>'PicURLs',''), '|', 1), 'as_of', last_seen) from r) end
$function$;

CREATE OR REPLACE FUNCTION pipeline.qty_add(p_pd text, p_add integer) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'pipeline', 'pg_catalog' AS $function$
declare L jsonb := pipeline.qty_lookup(p_pd); jid bigint;
begin
  if not coalesce((L->>'ok')::boolean, false) then return L; end if;
  if p_add is null or p_add < 1 or p_add > 500 then return jsonb_build_object('ok', false, 'error', 'Add between 1 and 500 copies.'); end if;
  if coalesce(L->>'status','') <> 'Listed' then return jsonb_build_object('ok', false, 'error', (L->>'pd') || ' is "' || coalesce(L->>'status','?') || '", not live - add copies only to a live listing.'); end if;
  if exists (select 1 from pipeline.qty_adds where pd = L->>'pd' and status = 'sending' and created_at > now() - interval '5 minutes') then
    return jsonb_build_object('ok', false, 'error', 'Already adding copies to ' || (L->>'pd') || ' - give it a minute.'); end if;
  insert into pipeline.qty_adds (pd, add_n, before_qty, condition, title) values (L->>'pd', p_add, (L->>'qty')::int, L->>'condition', L->>'title') returning id into jid;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/qty-set',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := jsonb_build_object('pd', L->>'pd', 'add', p_add, 'job', jid), timeout_milliseconds := 150000);
  return jsonb_build_object('ok', true, 'id', jid);
end $function$;

CREATE OR REPLACE FUNCTION pipeline.qty_adds_recent() RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pipeline', 'pg_catalog' AS $function$
  select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) from (
    select id, pd, add_n, before_qty, condition, title, case when status = 'sending' and created_at < now() - interval '4 minutes' then 'problem' else status end status,
      coalesce(result, case when status = 'sending' and created_at < now() - interval '4 minutes' then '{"error":"no answer from the stores - check the listing, then try again"}'::jsonb end) result,
      created_at from pipeline.qty_adds where created_at > now() - interval '3 days' order by id desc limit 5) x
$function$;
