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

-- Book Station scan-match (2026-11-22, "yes please"): a scanned ISBN already LIVE in the store -> "You already have this one" card with Add copies.
CREATE OR REPLACE FUNCTION pipeline.have_isbn(p_isbn text) RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pipeline', 'pg_catalog' AS $$
  with k as (select pipeline.isbn13(p_isbn) i),
  live as (select a.fields f from backup.airtable_records a, k
    where k.i is not null and a.table_id = 'tblKxgB4q7v9SPqze' and not coalesce(a.deleted_in_airtable, false)
      and a.fields->>'Status' = 'Listed' and pipeline.isbn13(a.fields->>'ISBN') = k.i),
  dr as (select d.pd, d.ident->>'title' t, coalesce(d.ident->>'grade', '') g, coalesce((d.answers->'station'->>'qty')::int, 1) q from pipeline.drafts d, k
    where k.i is not null and d.built_at is null and d.status in ('drafted','sent') and pipeline.isbn13(d.ident->>'isbn') = k.i)
  select jsonb_build_object('ok', true, 'isbn', (select i from k),
    'live', coalesce((select jsonb_agg(jsonb_build_object('pd', f->>'Tracking Number', 'title', f->>'Title', 'condition', f->>'Condition',
        'qty', coalesce((f->>'Quantity')::int, 1), 'price', f->>'Listed Price', 'cover', split_part(coalesce(f->>'PicURLs',''), '|', 1)) order by f->>'Tracking Number') from live), '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(jsonb_build_object('pd', pd, 'title', t, 'condition', g, 'qty', q)) from dr), '[]'::jsonb))
$$;
