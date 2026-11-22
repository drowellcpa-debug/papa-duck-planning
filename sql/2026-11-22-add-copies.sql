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

-- 2026-11-22 "remember abeka does not have bar code": cover-photo match by title words (numbers must match: grade 4 is not grade 5)
CREATE OR REPLACE FUNCTION pipeline.have_words(p text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  select coalesce(array_agg(distinct w), '{}') from regexp_split_to_table(lower(regexp_replace(coalesce(p,''), '[^A-Za-z0-9]+', ' ', 'g')), '\s+') w
  where (length(w) >= 2 or w ~ '^[0-9]+$') and w not in ('the','and','of','a','an','by','for','to','in','on','with','ed','edition','book','books','hc','pb','qty','batch','lot','vintage','new','used','set','vol','volume','paperback','hardcover')
$$;
CREATE OR REPLACE FUNCTION pipeline.have_book(p_isbn text, p_title text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'pipeline', 'pg_catalog' AS $$
declare h jsonb := pipeline.have_isbn(p_isbn); qw text[] := pipeline.have_words(p_title); qn text[]; live jsonb;
begin
  if coalesce(jsonb_array_length(h->'live'), 0) + coalesce(jsonb_array_length(h->'drafts'), 0) > 0 then return h || '{"by":"isbn"}'; end if;
  if coalesce(array_length(qw, 1), 0) < 2 then return jsonb_build_object('ok', true, 'live', '[]'::jsonb, 'drafts', '[]'::jsonb); end if;
  qn := array(select x from unnest(qw) x where x ~ '\d');
  select coalesce(jsonb_agg(m.j order by m.score desc, m.pd), '[]'::jsonb) into live from (
    select f->>'Tracking Number' pd, jsonb_build_object('pd', f->>'Tracking Number', 'title', f->>'Title', 'condition', f->>'Condition',
        'qty', coalesce((f->>'Quantity')::int, 1), 'price', f->>'Listed Price', 'cover', split_part(coalesce(f->>'PicURLs',''), '|', 1)) j,
      (select count(*) from unnest(qw) x where x = any(tw))::numeric / array_length(qw, 1) score
    from (select a.fields f, pipeline.have_words(a.fields->>'Title') tw from backup.airtable_records a
          where a.table_id = 'tblKxgB4q7v9SPqze' and not coalesce(a.deleted_in_airtable, false) and a.fields->>'Status' = 'Listed') c
    where qn <@ c.tw and (select count(*) from unnest(qw) x where x = any(c.tw)) >= least(3, array_length(qw, 1))
    order by 3 desc limit 3) m where m.score >= 0.7;
  return jsonb_build_object('ok', true, 'by', 'title', 'live', live, 'drafts', '[]'::jsonb);
end $$;

-- 2026-11-22 "change the titel myself ... these changes effect everything": rename everywhere via qty-set v6 (+ abe-qty v6)
CREATE OR REPLACE FUNCTION pipeline.title_set(p_pd text, p_title text) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'pipeline', 'pg_catalog' AS $$
declare L jsonb := pipeline.qty_lookup(p_pd); t text := regexp_replace(trim(coalesce(p_title,'')), '\s+', ' ', 'g'); jid bigint;
begin
  if not coalesce((L->>'ok')::boolean, false) then return L; end if;
  if length(t) < 3 then return jsonb_build_object('ok', false, 'error', 'Type the new name (at least 3 letters).'); end if;
  if length(t) > 200 then return jsonb_build_object('ok', false, 'error', 'That name is too long (200 letters max; eBay shows the first 80).'); end if;
  if exists (select 1 from pipeline.qty_adds where pd = L->>'pd' and status = 'sending' and created_at > now() - interval '5 minutes') then
    return jsonb_build_object('ok', false, 'error', (L->>'pd') || ' is still updating - give it a minute.'); end if;
  insert into pipeline.qty_adds (pd, add_n, before_qty, condition, title) values (L->>'pd', 0, (L->>'qty')::int, L->>'condition', t) returning id into jid;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/qty-set',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := jsonb_build_object('pd', L->>'pd', 'title', t, 'job', jid), timeout_milliseconds := 150000);
  return jsonb_build_object('ok', true, 'id', jid);
end $$;
