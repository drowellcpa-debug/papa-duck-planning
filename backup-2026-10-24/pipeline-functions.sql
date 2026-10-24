-- abe_clean
CREATE OR REPLACE FUNCTION pipeline.abe_clean(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select trim(regexp_replace(pipeline.asc(coalesce(s,'')), '[\t\r\n]+', ' ', 'g')) $function$


-- amazon_recheck
CREATE OR REPLACE FUNCTION pipeline.amazon_recheck(p_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
-- 2026-10-22 Papa Duck: "if I get amazon approval I can ask you to re look ... in one click inside the draft".
-- Clears the stored Amazon answer so it is asked again: one draft (p_id) or every open restricted draft (p_id null).
declare n int; pds text;
begin
  with r as (select id, pd, amazon from pipeline.drafts
             where built_at is null and archived_at is null and status in ('drafted','sent')
               and amazon is not null
               and (case when p_id is null then amazon->>'status' = 'restricted' else id = p_id end)),
  l as (insert into pipeline.amazon_recheck_log(pd, before) select pd, amazon from r returning pd),
  u as (update pipeline.drafts d set amazon = null, amazon_at = null from r where d.id = r.id returning d.pd)
  select count(*), string_agg(pd, ', ' order by pd) into n, pds from u;
  perform net.http_post(url:='https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/amazon-recheck',
    headers:=jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body:='{}'::jsonb, timeout_milliseconds:=150000) where n > 0;
  return jsonb_build_object('rechecking', n, 'pds', coalesce(pds,''));
end $function$


-- asc
CREATE OR REPLACE FUNCTION pipeline."asc"(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select btrim(regexp_replace(regexp_replace(
    replace(replace(replace(translate(pipeline.translit(coalesce(s,'')),
      'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿÑñÇçČčĆćĎďĚěŇňŘřŠšŤťŮůŽžŁłŃńŚśŹźŻżĄąĘęŐőŰű–—‘’“”·',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuYyyNnCcCcCcDdEeNnRrSsTtUuZzLlNnSsZzZzAaEeOoUu--''''""-'),
      '…','...'), chr(9), ' '), chr(10), ' '),
    '[^ -~]', '', 'g'), '\s+', ' ', 'g'))
$function$


-- auto_clear_built
CREATE OR REPLACE FUNCTION pipeline.auto_clear_built()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'backup', 'pg_catalog'
AS $function$
declare n int;
begin
  update pipeline.drafts d set built_at = now(), archived_at = coalesce(d.archived_at, now())
   where d.status = 'sent' and d.built_at is null and d.pd is not null
     and exists (select 1 from backup.airtable_records r
                  where r.table_id = 'tblKxgB4q7v9SPqze'
                    and r.fields->>'Tracking Number' = d.pd
                    and r.fields->>'Status' in ('Listed','Sold'));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'cleared', n);
end $function$


-- blast_pack
CREATE OR REPLACE FUNCTION pipeline.blast_pack(p_from text, p_to text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
-- 2026-10-17 (Papa Duck: "the blast has to be complete"): nothing is held back for price. Held books go at Claude's price, cleanup books at $6.99.
select coalesce(jsonb_agg(x order by x->>'pd'),'[]'::jsonb) from (
 select jsonb_build_object('id',d.id,'pd',d.pd,'ident',d.ident - 'audience' - 'condition_notes' - 'raw','pricing', jsonb_build_object('list',d.pricing->'list','auto',d.pricing->'auto','min',d.pricing->'min','band',d.pricing->'band','ebay_title',d.pricing->'ebay_title','b1',d.pricing->'b1','b2',d.pricing->'b2'),
  'price_override',d.price_override,'weight_lb',d.weight_lb,'channel',d.channel,'etsy',d.etsy,'etsy_year',pipeline.etsy_year(d),'amazon',d.amazon - 'reasons','amazon_on',d.amazon_on,'location',d.location,'is_set',d.is_set,
  'station',(d.answers->'station') - 'block' - 'filenames','answers_other',(d.answers - 'station' - 'tell'),
  'photos',(select jsonb_agg(p->>'url' order by o) from jsonb_array_elements(d.photos) with ordinality t(p,o) where not coalesce((p->>'removed')::boolean,false)),
  'md5_b1',md5(coalesce(d.pricing->>'b1','')),'md5_b2',md5(coalesce(d.pricing->>'b2',''))) x
 from pipeline.drafts d where d.status='sent' and d.built_at is null and d.archived_at is null and d.pd between p_from and p_to) s $function$


-- dispatch_preview
CREATE OR REPLACE FUNCTION pipeline.dispatch_preview(p_job bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare n int; st text; ch text;
begin
  select status, channel into st, ch from pipeline.send_jobs where id = p_job for update;
  if st is null then return jsonb_build_object('ok', false, 'error', 'no such job'); end if;
  if ch <> 'amazon' then return jsonb_build_object('ok', false, 'error', 'Preview is only for Amazon'); end if;
  if st = 'running' then return jsonb_build_object('ok', false, 'error', 'already running'); end if;
  update pipeline.send_items set state = 'queued', note = null, updated_at = now() where job_id = p_job and state in ('waiting','failed');
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing to preview'); end if;
  update pipeline.send_jobs set status = 'running', run_mode = 'preview', started_at = coalesce(started_at, now()), finished_at = null, updated_at = now() where id = p_job;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/send-worker?action=kick',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 20000);
  return jsonb_build_object('ok', true, 'queued', n);
end $function$


-- dispatch_set_price
CREATE OR REPLACE FUNCTION pipeline.dispatch_set_price(p_pd text, p_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare it record; old_l numeric; old_m numeric; new_auto numeric; new_min numeric; ratio numeric; changed text[] := '{}'; blocked text[] := '{}';
  lines text[]; i int; cols text[];
begin
  if p_price is null or p_price < 1 then return jsonb_build_object('ok', false, 'error', 'price must be at least $1'); end if;
  p_price := round(p_price, 2);
  -- the eBay row decides auto/min (Rule BP.3: he sets the list price, Auto = 80%, Min keeps its place in the band)
  select (payload->>'lst')::numeric, (payload->>'mn')::numeric into old_l, old_m from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
   where i.pd = p_pd and j.channel = 'ebay' and j.status <> 'closed' order by j.id desc limit 1;
  ratio := case when old_l > 0 and old_m > 0 then old_m / old_l else 0.6 end;
  new_auto := round(p_price * 0.8 * 2) / 2; new_min := round(p_price * ratio * 2) / 2;
  if new_auto >= p_price then new_auto := round(p_price - 0.5, 2); end if;
  if new_min > new_auto then new_min := new_auto; end if;
  for it in select i.id, i.state, j.channel, j.id job_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
            where i.pd = p_pd and j.status <> 'closed' and j.test = false loop
    if it.state not in ('waiting','failed') then blocked := blocked || it.channel; continue; end if;
    if it.channel = 'ebay' then
      update pipeline.send_items set payload = payload || jsonb_build_object('lst', p_price, 'auto', new_auto, 'mn', new_min, 'price_changed', true), updated_at = now() where id = it.id;
    elsif it.channel in ('etsy','amazon') then
      update pipeline.send_items set payload = jsonb_set(payload, '{price}', to_jsonb(to_char(p_price, 'FM999990.00'))), updated_at = now() where id = it.id;
    elsif it.channel = 'abe' then
      select string_to_array(data_file, chr(10)) into lines from pipeline.send_jobs where id = it.job_id;
      for i in 2 .. coalesce(array_length(lines, 1), 0) loop
        if split_part(lines[i], chr(9), 1) = p_pd then
          cols := string_to_array(lines[i], chr(9)); cols[5] := to_char(p_price, 'FM999990.00'); lines[i] := array_to_string(cols, chr(9));
        end if;
      end loop;
      update pipeline.send_jobs set data_file = array_to_string(lines, chr(10)), updated_at = now() where id = it.job_id and data_state <> 'sent';
      if not found then blocked := blocked || 'abe'; continue; end if;
    end if;
    changed := changed || it.channel;
  end loop;
  return jsonb_build_object('ok', true, 'pd', p_pd, 'price', p_price, 'auto', new_auto, 'min', new_min, 'changed', changed, 'already_sent', blocked);
end $function$


-- dispatch_start
CREATE OR REPLACE FUNCTION pipeline.dispatch_start(p_job bigint, p_only_first boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare n int; st text;
begin
  select status into st from pipeline.send_jobs where id = p_job for update;
  if st is null then return jsonb_build_object('ok', false, 'error', 'no such job'); end if;
  if st = 'running' then return jsonb_build_object('ok', false, 'error', 'already sending'); end if;
  update pipeline.send_items set state = 'queued', note = null, updated_at = now()
   where job_id = p_job and state in ('waiting','failed','short')
     and (not p_only_first or id = (select id from pipeline.send_items where job_id = p_job and state in ('waiting','failed','short') order by seq limit 1));
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing left to send'); end if;
  update pipeline.send_jobs set status = 'running', run_mode = 'live', started_at = coalesce(started_at, now()), finished_at = null, updated_at = now(),
    data_state = case when channel = 'abe' and data_state <> 'sent' then 'waiting' else data_state end where id = p_job;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/send-worker?action=kick',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 20000);
  return jsonb_build_object('ok', true, 'queued', n);
end $function$


-- dispatch_status
CREATE OR REPLACE FUNCTION pipeline.dispatch_status(p_limit integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(j order by (j->>'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object('id', s.id, 'channel', s.channel, 'name', s.name, 'status', s.status, 'test', s.test, 'run_mode', s.run_mode, 'night', s.night,
      'data_state', s.data_state, 'data_name', s.data_name, 'summary', s.summary, 'created', s.created_at, 'started', s.started_at, 'finished', s.finished_at,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('pd', i.pd, 'state', i.state, 'photos', i.photos, 'names', i.names, 'note', i.note,
                  'n', least(case when s.channel = 'ebay' then 24 else 20 end, coalesce(jsonb_array_length(i.payload->'image_urls'), jsonb_array_length(i.payload->'urls'), jsonb_array_length(i.payload->'pics'), 0)),
                  'price', coalesce(i.payload->>'lst', i.payload->>'price'),
                  'listing_id', i.listing_id, 'title', coalesce(i.payload->>'title', '')) order by i.seq), '[]'::jsonb)
                from pipeline.send_items i where i.job_id = s.id)) j
    from pipeline.send_jobs s order by s.id desc limit p_limit) x;
$function$


-- drafts_auto_questions
CREATE OR REPLACE FUNCTION pipeline.drafts_auto_questions()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare qs jsonb := coalesce(new.questions, '[]'::jsonb); lst numeric; t text; n int;
begin
  if new.status is distinct from 'drafted' then return new; end if;
  lst := coalesce(new.price_override, nullif(new.pricing->>'list','')::numeric);
  if lst >= 40 and not exists (select 1 from jsonb_array_elements(qs) q where q->>'auto' = 'price40') then
    n := nullif(new.pricing->>'n','')::int;
    qs := qs || jsonb_build_array(jsonb_build_object('auto','price40',
      'q', 'Price check: $' || to_char(lst,'FM999990.00') || ' from ' || coalesce(n,0) || ' eBay match(es), $' || coalesce(new.pricing->>'low','?') || ' to $' || coalesce(new.pricing->>'high','?') || '. Keep it, or type your price under Your price first.',
      'options', jsonb_build_array('Keep this price','I typed my own price')));
  end if;
  t := lower(coalesce(new.ident::text,'') || ' ' || coalesce(new.pricing->>'b1','') || ' ' || coalesce(new.pricing->>'b2',''));
  if t ~ '(photocop|self-?printed|home-?printed|good and the beautiful|jenny phillips)'
     and not exists (select 1 from jsonb_array_elements(qs) q where q->>'auto' = 'copycheck') then
    qs := qs || jsonb_build_array(jsonb_build_object('auto','copycheck',
      'q', 'Copy check: something here may be photocopied, self-printed, or The Good and the Beautiful. What should we do?',
      'options', jsonb_build_array('Real publisher copy - list it','Leave that piece out','Do not list this book')));
  end if;
  new.questions := qs;
  return new;
end $function$


-- drafts_auto_regrade
CREATE OR REPLACE FUNCTION pipeline.drafts_auto_regrade()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
-- 2026-10-17 Papa Duck: "yes" (make it automatic). When the price worker finds the condition notes describe more wear than the grade
-- (pricing.suggested_grade), switch the grade itself and re-run the listing so Block 1 says the new grade. Once per draft only
-- (answers.auto_regrade), so if Papa Duck sets it back by hand, his grade stands.
declare sg text := coalesce(NEW.pricing->>'suggested_grade','');
begin
  if NEW.built_at is null and sg <> '' and sg <> coalesce(NEW.ident->>'grade','') and coalesce(NEW.answers->>'auto_regrade','') = '' then
    NEW.answers := coalesce(NEW.answers,'{}'::jsonb) || jsonb_build_object('auto_regrade', coalesce(NEW.ident->>'grade','?') || ' -> ' || sg || ' (notes describe more wear), ' || to_char(now() at time zone 'America/Los_Angeles','YYYY-MM-DD HH24:MI'));
    NEW.ident := jsonb_set(coalesce(NEW.ident,'{}'::jsonb), '{grade}', to_jsonb(sg));
    NEW.price_stale := true; NEW.price_attempts := 0; NEW.price_claimed_at := null;
    NEW.updated_at := now() - interval '1 minute';
  end if;
  return NEW;
end $function$


-- drafts_scout_note
CREATE OR REPLACE FUNCTION pipeline.drafts_scout_note()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare s record; k text; tt text;
begin
  if new.ident is null or (tg_op = 'UPDATE' and old.ident is not null) then return new; end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(new.flags,'[]'::jsonb)) f where f like '📊 Scout%') then return new; end if;
  k := pipeline.isbn13(new.ident->>'isbn');
  tt := lower(trim(coalesce(new.ident->>'title','')));
  select * into s from pipeline.scout_scans x
   where x.created_at > now() - interval '120 days'
     and ((k is not null and pipeline.isbn13(x.isbn) = k)
          or (k is null and length(tt) >= 6 and lower(trim(x.title)) = tt))
   order by (x.verdict in ('LIST','BUY')) desc, x.created_at desc limit 1;
  if found then
    new.flags := coalesce(new.flags,'[]'::jsonb) || to_jsonb('📊 Scout (' || to_char(s.created_at at time zone 'America/Los_Angeles','Mon DD') || ', ' ||
      case when s.mode = 'cleanup' then 'clean-up' else 'scouting' end || '): ' || s.summary);
  end if;
  return new;
end $function$


-- drafts_unarchive_on_reopen
CREATE OR REPLACE FUNCTION pipeline.drafts_unarchive_on_reopen()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.status in ('drafted','processing') and old.status in ('sent','dont_list','failed') then new.archived_at := null; end if;
  return new;
end $function$


-- etsy_export
CREATE OR REPLACE FUNCTION pipeline.etsy_export(p_pds text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'pd', d.pd, 'status', d.status, 'built_at', d.built_at, 'channel', d.channel,
    'etsy_year', pipeline.etsy_year(d), 'etsy_rec', d.etsy_rec,
    'title', d.ident->>'title', 'author', d.ident->>'author', 'publisher', d.ident->>'publisher',
    'publication_year', d.ident->>'publication_year', 'format', d.ident->>'format', 'grade', d.ident->>'grade',
    'subject', coalesce(d.ident->>'genre_or_subject',''), 'is_set', d.is_set,
    'price', coalesce(d.price_override, nullif(d.pricing->>'list','')::numeric),
    'qty', coalesce(nullif(d.answers->'station'->>'qty','')::int, 1),
    'weight_lb', d.weight_lb,
    'ebay_title', d.pricing->>'ebay_title', 'b1', d.pricing->>'b1', 'b2', d.pricing->>'b2',
    'photos', (select coalesce(jsonb_agg(ph->>'url' order by ord), '[]'::jsonb)
                 from jsonb_array_elements(d.photos) with ordinality t(ph, ord)
                where coalesce((ph->>'removed')::boolean, false) = false and coalesce(ph->>'url','') <> '')
  ) order by d.pd), '[]'::jsonb)
  from pipeline.drafts d
  where d.etsy and d.status = 'sent' and d.channel <> 'amazon'
    and (p_pds is null or d.pd = any(p_pds));
$function$


-- etsy_plain
CREATE OR REPLACE FUNCTION pipeline.etsy_plain(b2 text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare h text := pipeline.translit(coalesce(b2,'')); l text; o text[] := '{}'; t text;
begin
  h := regexp_replace(h, '<h[23][^>]*>\s*', E'\n\n', 'gi'); h := regexp_replace(h, '</h[23]>', E'\n', 'gi');
  h := regexp_replace(h, '<li[^>]*>\s*', E'\n- ', 'gi'); h := regexp_replace(h, '<br\s*/?>', E'\n', 'gi');
  h := regexp_replace(h, '</p>|<p[^>]*>|</ul>|<ul[^>]*>|</div>|<div[^>]*>', E'\n', 'gi');
  h := regexp_replace(h, '<[^>]+>', '', 'g');
  h := replace(replace(replace(replace(replace(replace(h,'&amp;','&'),'&quot;','"'),'&#39;',''''),'&lt;','<'),'&gt;','>'),'&nbsp;',' ');
  h := replace(replace(h,'·','|'),'…','...');
  h := translate(h, 'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿÑñÇçČčĆćĎďĚěŇňŘřŠšŤťŮůŽžŁłŃńŚśŹźŻżĄąĘęŐőŰű–—‘’“”',
                    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuYyyNnCcCcCcDdEeNnRrSsTtUuZzLlNnSsZzZzAaEeOoUu--''''""');
  h := regexp_replace(h, '[^\n -~]', '', 'g'); h := regexp_replace(h, '[ \t]+', ' ', 'g');
  foreach l in array string_to_array(h, E'\n') loop
    l := btrim(l);
    if l ~ '^(Book Details|Condition:.*)$' then l := upper(l); end if;
    if l like '- %' and btrim(substr(l,3)) = '' then continue; end if;
    if l = '-' then continue; end if;
    o := o || l;
  end loop;
  t := btrim(regexp_replace(array_to_string(o, E'\n'), E'\n{3,}', E'\n\n', 'g'), E' \n');
  t := btrim(regexp_replace(t, E'(^|\n)[^\n]*Ships via USPS Media Mail[^\n]*', '', 'g'), E' \n');
  if position('Every book opens a door' in t) = 0 then t := t || E'\n\nPapa Duck Homeschool | Gresham, Oregon\n"Every book opens a door to knowledge; wisdom begins when we step through it."'; end if;
  return regexp_replace(t, E'\n{3,}', E'\n\n', 'g');
end $function$


-- etsy_rec_coloring
CREATE OR REPLACE FUNCTION pipeline.etsy_rec_coloring()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
-- 2026-10-24 Papa Duck: "adult coloring books like dover need to be listed on etsy" / "follow etsy rules ... never the rules".
-- 2026-10-24: "so etsy if you recommend it turn it on automatically" -> recommended + ELIGIBLE = Etsy ON (etsy_by='auto') unless he set it himself (etsy_by='him').
-- 2026-10-24: "art books or drawing quilt books auto turn on etsy" -> art, drawing/painting and quilting books join coloring books.
-- 2026-10-24: "all bible and condordances and study bibles on etsy only if rules match" -> Bibles, study Bibles, Testaments and concordances too.
--   Etsy's 20-year rule is never bent. "art" excludes Language/Liberal/Martial/Industrial/Graphic/Culinary Arts and "The Art of ..." titles.
declare yr int := pipeline.etsy_year(new); cutoff int := extract(year from now())::int - 20; eligible boolean; txt text; kind text;
begin
  eligible := yr is not null and yr <= cutoff and coalesce(new.channel,'') not in ('amazon','fba','dont_list','goodwill','trash');
  if tg_op = 'UPDATE' and new.etsy is distinct from old.etsy and new.etsy_by is not distinct from old.etsy_by then new.etsy_by := 'him'; end if;
  txt := coalesce(new.ident->>'title','') || ' ' || coalesce(new.ident->>'subtitle_or_series','') || ' ' || coalesce(new.ident->>'genre_or_subject','');
  kind := case when txt ~* '(concordance)' then 'Bible concordance'
               when txt ~* '(\mbibles?\M|\mnew testament|\mold testament)' then 'Bible'
               when txt ~* 'colou?ring' then 'coloring book'
               when txt ~* '(quilt|patchwork|appliqu)' then 'quilting book'
               when txt ~* '(\mdrawing|\msketch|\mpainting|watercolou?r|\mpastel|\mcalligraph)' then 'drawing and painting book'
               when regexp_replace(txt, '(language|liberal|martial|industrial|graphic|culinary)\s+arts?|\mthe art of\M|\mart of\M', '', 'gi') ~* '(\mart\M|\marts\M|\martist|\mfine art)' then 'art book'
               else null end;
  if kind is not null and new.etsy_rec is not null and coalesce((new.etsy_rec->>'rec')::boolean, false) = false and eligible then
    new.etsy_rec := new.etsy_rec || jsonb_build_object('rec', true, 'why', 'Vintage ' || kind || ' (' || yr || ') - Etsy shoppers buy these.', 'rule', kind);
  end if;
  if coalesce((new.etsy_rec->>'rec')::boolean, false) and eligible and new.etsy_by is null and coalesce(new.etsy, false) = false and new.built_at is null then
    new.etsy := true; new.etsy_by := 'auto';
  end if;
  if new.etsy and not eligible and coalesce(new.etsy_by,'') = 'auto' then new.etsy := false; end if;
  return new;
end $function$


-- etsy_year
CREATE OR REPLACE FUNCTION pipeline.etsy_year(d pipeline.drafts)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(substring(coalesce(d.ident->>'publication_year','') from '(1[5-9]\d\d|20\d\d)'),'')::int
$function$


-- fba_from_blastoff
CREATE OR REPLACE FUNCTION pipeline.fba_from_blastoff()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare r record; ok text[] := '{}'; bad text[] := '{}'; res jsonb;
begin
  for r in select id, pd from pipeline.drafts where status = 'sent' and built_at is null and channel = 'fba'
             and not (coalesce((ident->'audience'->>'ok')::boolean, true) = false and coalesce(answers->>'audience_ok','') <> 'yes') order by pd loop
    begin
      res := pipeline.fba_send(r.id);
      ok := array_append(ok, r.pd);
    exception when others then
      bad := array_append(bad, coalesce(r.pd, 'draft ' || r.id) || ': ' || sqlerrm);
    end;
  end loop;
  return jsonb_build_object('fba', coalesce(array_length(ok, 1), 0), 'fba_pds', array_to_string(ok, ', '), 'fba_problems', to_jsonb(bad), 'box', pipeline.fba_open_box());
end $function$


-- fba_kick
CREATE OR REPLACE FUNCTION pipeline.fba_kick()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  select net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/fba-cloud?action=work',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000); $function$


-- fba_list
CREATE OR REPLACE FUNCTION pipeline.fba_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
  select jsonb_build_object(
    'open_box', pipeline.fba_open_box(),
    'boxes', coalesce((select jsonb_agg(jsonb_build_object('n', b.n, 'opened_at', b.opened_at, 'closed_at', b.closed_at, 'shipped_at', b.shipped_at,
        'count', (select count(*) from pipeline.fba_items i where i.box = b.n and i.status <> 'removed')) order by b.n desc) from pipeline.fba_boxes b), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'draft_id', i.draft_id, 'pd', i.pd, 'box', i.box, 'asin', i.asin, 'cond', i.cond,
        'price', i.price, 'title', i.title, 'author', i.author, 'cover', i.cover, 'status', i.status, 'fnsku', i.fnsku, 'error', i.error,
        'printed_at', i.printed_at, 'print_requested_at', i.print_requested_at, 'print_error', i.print_error, 'prints', i.prints,
        'created_at', i.created_at, 'updated_at', i.updated_at,
        'cover_drive', (select ph->>'drive_id' from pipeline.drafts d, jsonb_array_elements(d.photos) ph where d.id = i.draft_id and not coalesce((ph->>'removed')::boolean,false) limit 1))
        order by i.created_at desc) from pipeline.fba_items i where i.status <> 'removed'), '[]'::jsonb),
    'printer_seen', (select value from backup.config where key = 'fba_printer_seen')); $function$


-- fba_mark_printed
CREATE OR REPLACE FUNCTION pipeline.fba_mark_printed(p_ids bigint[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
 with u as (update pipeline.fba_items set printed_at = now(), prints = prints + 1, print_error = null, print_requested_at = null, updated_at = now()
   where id = any(p_ids) and fnsku is not null returning pd) select jsonb_build_object('ok', true, 'marked', (select jsonb_agg(pd) from u)) $function$


-- fba_move
CREATE OR REPLACE FUNCTION pipeline.fba_move(p_item bigint, p_box integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  if not exists (select 1 from pipeline.fba_boxes where n = p_box and shipped_at is null) then raise exception 'Box % does not exist or has shipped.', p_box; end if;
  update pipeline.fba_items set box = p_box, airtable_dirty = true, updated_at = now() where id = p_item and status <> 'removed';
  return jsonb_build_object('ok', true);
end $function$


-- fba_new_box
CREATE OR REPLACE FUNCTION pipeline.fba_new_box()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare cur int := pipeline.fba_open_box(); nxt int;
begin
  if (select count(*) from pipeline.fba_items where box = cur and status <> 'removed') = 0 and (select closed_at from pipeline.fba_boxes where n = cur) is null
    then raise exception 'Box % is still empty - keep using it.', cur; end if;
  update pipeline.fba_boxes set closed_at = now() where n = cur and closed_at is null;
  nxt := (select max(n) from pipeline.fba_boxes) + 1;
  insert into pipeline.fba_boxes (n) values (nxt);
  return jsonb_build_object('ok', true, 'closed', cur, 'open_box', nxt);
end $function$


-- fba_open_box
CREATE OR REPLACE FUNCTION pipeline.fba_open_box()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
  select coalesce((select max(n) from pipeline.fba_boxes where closed_at is null), (select max(n) from pipeline.fba_boxes)); $function$


-- fba_print_request
CREATE OR REPLACE FUNCTION pipeline.fba_print_request(p_ids bigint[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
 with u as (update pipeline.fba_items set print_requested_at = now(), print_error = null, updated_at = now()
   where id = any(p_ids) and fnsku is not null and status = 'ready' returning pd) select jsonb_build_object('ok', true, 'sent', (select jsonb_agg(pd) from u)) $function$


-- fba_reprint
CREATE OR REPLACE FUNCTION pipeline.fba_reprint(p_item bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  update pipeline.fba_items set print_requested_at = now(), print_error = null, updated_at = now() where id = p_item and fnsku is not null;
  if not found then raise exception 'No sticker yet - Amazon has not given this book its FNSKU.'; end if;
  return jsonb_build_object('ok', true);
end $function$


-- fba_retry
CREATE OR REPLACE FUNCTION pipeline.fba_retry(p_item bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  update pipeline.fba_items set status = case when fnsku is null then 'queued' else 'ready' end, error = null, attempts = 0, next_try = now(),
         price = coalesce((select coalesce(d.price_override, nullif(d.pricing->>'list','')::numeric) from pipeline.drafts d where d.id = draft_id), price),
         updated_at = now()
   where id = p_item and status = 'error';
  if not found then raise exception 'Nothing to retry on this one.'; end if;
  perform pipeline.fba_kick();
  return jsonb_build_object('ok', true);
end $function$


-- fba_send
CREATE OR REPLACE FUNCTION pipeline.fba_send(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare d pipeline.drafts; price numeric; cond text; box int; miss text[] := '{}'; i int; q jsonb; dup text; cov text;
begin
  select * into d from pipeline.drafts where id = p_id for update;
  if not found then raise exception 'Draft % not found', p_id; end if;
  if d.status = 'fba' then raise exception '% is already in FBA box %.', d.pd, (select box from pipeline.fba_items where draft_id = p_id); end if;
  if d.status not in ('drafted','sent') or d.built_at is not null then raise exception 'Only a book waiting in Drafts can go to FBA (this one is %).', d.status; end if;
  if coalesce((d.ident->>'do_not_list')::boolean, false) then raise exception 'This book is marked Do not list.'; end if;
  if d.pd is null or d.pd !~ '^PD-\d{4}[A-Z]?$' then miss := array_append(miss, 'PD number'); end if;
  price := coalesce(d.price_override, nullif(d.pricing->>'list','')::numeric);
  if price is null or price <= 0 then miss := array_append(miss, 'a price'); end if;
  if coalesce(d.amazon->>'status','') <> 'ok' or coalesce(d.amazon->>'asin','') !~ '^[0-9A-Z]{10}$' then
    raise exception 'FBA needs an Amazon page you are allowed to sell on. This book: %', case coalesce(d.amazon->>'status','')
      when 'restricted' then 'restricted in this condition' when 'not_on_amazon' then 'not on Amazon' when '' then 'not checked against Amazon yet (Dispatch checks every 2 minutes)' else 'Amazon check failed' end;
  end if;
  cond := case d.ident->>'grade' when 'Like New' then 'used_like_new' when 'Very Good' then 'used_very_good' when 'Good' then 'used_good'
            when 'Acceptable' then 'used_acceptable' when 'Brand New' then 'new_new' when 'New' then 'new_new' end;
  if cond is null then miss := array_append(miss, 'a grade'); end if;
  if coalesce(d.pricing->>'b1','') = '' then miss := array_append(miss, 'the condition description (still being written)'); end if;
  if d.price_stale then miss := array_append(miss, 'the price update to finish (about a minute)'); end if;
  if coalesce(((d.answers->'station'->>'qty'))::int, 1) <> 1 then miss := array_append(miss, 'quantity 1 (FBA is one sticker per book - send extra copies one at a time)'); end if;
  i := 0;
  for q in select * from jsonb_array_elements(coalesce(d.questions,'[]'::jsonb)) loop
    if q->>'q' <> 'Anything the photos can''t show?' and coalesce(trim(d.answers->>(i::text)), '') = '' then miss := array_append(miss, 'answer to: ' || (q->>'q')); end if;
    i := i + 1;
  end loop;
  if coalesce(array_length(miss, 1), 0) > 0 then raise exception 'Not ready for FBA. Still needed: %', array_to_string(miss, '; '); end if;
  select p2.scan || ' ' || p2.p into dup from pipeline.drafts p2 where p2.pd = d.pd and p2.id <> d.id and p2.status <> 'dont_list' limit 1;
  if dup is not null then raise exception '% is already used on %. A PD number belongs to one book.', d.pd, dup; end if;
  box := pipeline.fba_open_box();
  select ph->>'url' into cov from jsonb_array_elements(d.photos) ph where not coalesce((ph->>'removed')::boolean, false) and coalesce(ph->>'url','') like 'https://%' limit 1;
  insert into pipeline.fba_items (draft_id, pd, box, asin, cond, price, product_type, title, author, cover)
    values (d.id, d.pd, box, d.amazon->>'asin', cond, round(price, 2), nullif(d.amazon->>'product_type',''),
            coalesce(nullif(d.amazon->>'amazon_title',''), d.ident->>'title'), d.ident->>'author', cov)
    on conflict (draft_id) do update set pd = excluded.pd, box = excluded.box, asin = excluded.asin, cond = excluded.cond, price = excluded.price,
      product_type = excluded.product_type, title = excluded.title, author = excluded.author, cover = excluded.cover,
      status = 'queued', fnsku = null, error = null, attempts = 0, next_try = now(), airtable_dirty = true,
      print_requested_at = null, printed_at = null, print_error = null, updated_at = now();
  update pipeline.drafts set status = 'fba', channel = 'fba', etsy = false, amazon_on = false, sent_at = now(), updated_at = now() where id = p_id;
  perform pipeline.fba_kick();
  return jsonb_build_object('ok', true, 'pd', d.pd, 'box', box, 'price', round(price, 2));
end $function$


-- fba_station
CREATE OR REPLACE FUNCTION pipeline.fba_station()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
select jsonb_build_object(
 'open_box', pipeline.fba_open_box(),
 'printer', (select (value::jsonb)->>'printer' from backup.config where key = 'fba_printer_seen'),
 'printer_age', (select extract(epoch from now() - ((value::jsonb)->>'at')::timestamptz)::int from backup.config where key = 'fba_printer_seen'),
 'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'pd', d.pd, 'title', d.ident->>'title',
     'price', coalesce(d.price_override, nullif(d.pricing->>'list','')::numeric),
     'held', (coalesce((d.ident->'audience'->>'ok')::boolean, true) = false and coalesce(d.answers->>'audience_ok','') <> 'yes'),
     'amazon', d.amazon->>'status') order by d.pd)
   from pipeline.drafts d where d.status = 'sent' and d.built_at is null and d.channel = 'fba'), '[]'::jsonb),
 'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'pd', i.pd, 'box', i.box, 'title', i.title, 'cond', i.cond, 'price', i.price,
     'status', i.status, 'fnsku', i.fnsku, 'error', i.error, 'printed_at', i.printed_at, 'prints', i.prints, 'updated_at', i.updated_at,
     'print_pending', (i.print_requested_at is not null and (i.printed_at is null or i.printed_at < i.print_requested_at) and i.print_requested_at > now() - interval '2 days'),
     'print_error', i.print_error) order by i.created_at desc)
   from pipeline.fba_items i where i.status <> 'removed' and (i.box = pipeline.fba_open_box() or i.printed_at is null or i.status <> 'ready')), '[]'::jsonb)) $function$


-- fba_tick
CREATE OR REPLACE FUNCTION pipeline.fba_tick()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  select pipeline.fba_kick() where exists (select 1 from pipeline.fba_items
    where (status in ('queued','listing','waiting_fnsku','removing') and next_try <= now()) or (status = 'ready' and airtable_dirty)); $function$


-- fba_undo
CREATE OR REPLACE FUNCTION pipeline.fba_undo(p_item bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare it pipeline.fba_items;
begin
  select * into it from pipeline.fba_items where id = p_item for update;
  if not found or it.status = 'removed' then raise exception 'Not in FBA.'; end if;
  if (select shipped_at from pipeline.fba_boxes where n = it.box) is not null then raise exception 'Box % already shipped to Amazon - it can''t be undone here.', it.box; end if;
  update pipeline.fba_items set status = 'removing', next_try = now(), attempts = 0, error = null, updated_at = now() where id = p_item;
  perform pipeline.fba_kick();
  return jsonb_build_object('ok', true, 'pd', it.pd);
end $function$


-- isbn13
CREATE OR REPLACE FUNCTION pipeline.isbn13(s text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
-- 2026-10-19: never throw. A half-read ISBN (PD-3368 "0 14 00.003X 5") put X mid-string and the ::int cast
-- blocked Send to Drafts. X is valid only as an ISBN-10 check digit; anything else returns null.
declare d text := upper(regexp_replace(coalesce(s,''), '[^0-9Xx]', '', 'g')); b text; t int := 0; i int;
begin
  if d ~ '^\d{13}$' then return d; end if;
  if d !~ '^\d{9}[\dX]$' then return null; end if;
  b := '978' || left(d, 9);
  for i in 1..12 loop t := t + (substr(b, i, 1))::int * case when i % 2 = 0 then 3 else 1 end; end loop;
  return b || ((10 - t % 10) % 10)::text;
exception when others then return null;
end $function$


-- kick_price_worker
CREATE OR REPLACE FUNCTION pipeline.kick_price_worker()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  select net.http_post(
    url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/price-worker',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$function$


-- kick_scan_folders
CREATE OR REPLACE FUNCTION pipeline.kick_scan_folders()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  select net.http_post(
    url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scan-folders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$function$


-- kick_worker
CREATE OR REPLACE FUNCTION pipeline.kick_worker()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  select net.http_post(
    url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/drafts-worker',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$function$


-- mark_built
CREATE OR REPLACE FUNCTION pipeline.mark_built(p_pds text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare n int;
begin
  update pipeline.drafts set built_at = coalesce(built_at, now()), archived_at = coalesce(archived_at, now())
   where status = 'sent' and built_at is null and pd = any(p_pds);
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'cleared', n);
end $function$


-- price_held
CREATE OR REPLACE FUNCTION pipeline.price_held(p_draft bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (select 1 from pipeline.price_review r where r.draft_id = p_draft and r.status in ('waiting','needs_papa_duck','reviewed')) $function$


-- price_review_apply
CREATE OR REPLACE FUNCTION pipeline.price_review_apply()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
-- 2026-10-17 20:33 Papa Duck: "make sure this does not happen again" - this morning's approved $6.99 review rows were applied at blast off
-- on top of tonight's re-priced drafts. Now a review row only becomes the draft's price when ALL of these hold:
--   it is for a DRAFT (not a listed book), it is approved, it is Claude's or Papa Duck's own (never Perplexity's),
--   it was decided AFTER the draft was last priced (an older decision is stale and is closed as superseded),
--   it is not under the minimum list price, and Papa Duck has not typed his own price.
declare r record; did bigint; dpriced timestamptz; dov numeric; done text[] := '{}'; grades text[] := '{}'; stale text[] := '{}';
        minl numeric := coalesce((select value::numeric from pipeline.config where key = 'min_list_drafts'), 9.99);
begin
  for r in select * from pipeline.price_review where status = 'approved' and recommended_price > 0 and coalesce(evidence->>'listed','') <> 'true' order by id loop
    select id, priced_at, price_override into did, dpriced, dov from pipeline.drafts
      where id = coalesce(r.draft_id, (select id from pipeline.drafts where pd = r.pd and built_at is null order by id desc limit 1)) and built_at is null;
    if did is null then
      update pipeline.price_review set status = 'rejected', push_note = 'no open draft' where id = r.id; continue; end if;
    if r.reviewer = 'perplexity' and coalesce((r.evidence->>'papa_duck_ok')::boolean, false) = false
       or coalesce(r.decided_at, r.created_at) < coalesce(dpriced, '-infinity')
       or r.recommended_price < minl
       or dov is not null then
      update pipeline.price_review set status = 'rejected', push_note = 'superseded: stale, below minimum, Perplexity, or Papa Duck typed his own price' where id = r.id;
      stale := array_append(stale, r.pd); continue;
    end if;
    update pipeline.drafts set price_override = round(r.recommended_price, 2), updated_at = now() where id = did;
    update pipeline.price_review set status = 'applied', applied_at = now() where id = r.id;
    done := array_append(done, r.pd || ' $' || round(r.recommended_price, 2));
    if coalesce(r.suggested_grade, '') <> '' then grades := array_append(grades, r.pd || ' -> ' || r.suggested_grade); end if;
  end loop;
  return jsonb_build_object('applied', to_jsonb(done), 'grade_questions', to_jsonb(grades), 'skipped_stale', to_jsonb(stale));
end $function$


-- price_review_decide
CREATE OR REPLACE FUNCTION pipeline.price_review_decide(p_id bigint, p_ok boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  -- Papa Duck's own Approve also marks papa_duck_ok, so the live re-price push lets a big (40%+) change through
  update pipeline.price_review set status = case when p_ok then 'approved' else 'rejected' end, decided_at = now(),
         evidence = case when p_ok then coalesce(evidence,'{}'::jsonb) || '{"papa_duck_ok": true}'::jsonb else evidence end
   where id = p_id and status in ('needs_papa_duck','reviewed','waiting');
  if not found then raise exception 'That review is already decided.'; end if;
  return jsonb_build_object('ok', true, 'status', case when p_ok then 'approved' else 'rejected' end);
end $function$


-- price_review_list
CREATE OR REPLACE FUNCTION pipeline.price_review_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'pd', r.pd, 'draft_id', r.draft_id, 'current', r.current_price, 'recommended', r.recommended_price,
    'grade', r.suggested_grade, 'confidence', r.confidence, 'reason', r.reason, 'reviewer', r.reviewer, 'status', r.status, 'created_at', r.created_at,
    'title', d.ident->>'title') order by r.created_at desc), '[]'::jsonb)
  from pipeline.price_review r left join pipeline.drafts d on d.id = r.draft_id
  where r.status in ('waiting','needs_papa_duck','reviewed','approved') $function$


-- queue_ebay
CREATE OR REPLACE FUNCTION pipeline.queue_ebay(p_name text, p_items jsonb, p_test boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare jid bigint; it jsonb; d record; spec jsonb; hdr jsonb; rw jsonb; k text; v text; n int := 0; missing text[] := '{}'; seqn int := 0;
begin
  insert into pipeline.send_jobs(channel, name, status, test) values ('ebay', p_name, 'ready', p_test) returning id into jid;
  for it in select * from jsonb_array_elements(p_items) loop
    seqn := seqn + 1;
    select pricing, photos into d from pipeline.drafts where pd = it->>'pd' order by (built_at is null) desc, id desc limit 1;
    if d.pricing is null then missing := missing || (it->>'pd'); continue; end if;
    spec := coalesce(it->'specs', '{}'::jsonb);
    hdr := jsonb_build_array('*Category', 'StoreCategory'); rw := jsonb_build_array(it->>'cat', it->>'store');
    for k, v in select key, value from jsonb_each_text(spec) loop hdr := hdr || to_jsonb('C:' || k); rw := rw || to_jsonb(v); end loop;
    insert into pipeline.send_items(job_id, pd, seq, payload) values (jid, it->>'pd', seqn,
      (it - 'specs') || jsonb_build_object(
        'b1', coalesce(it->>'b1', d.pricing->>'b1'), 'b2', coalesce(it->>'b2', d.pricing->>'b2'),
        'pics', coalesce(it->'pics', (select jsonb_agg(ph->>'url' order by o) from jsonb_array_elements(d.photos) with ordinality t(ph, o)
                                      where coalesce((ph->>'removed')::boolean, false) = false and coalesce(ph->>'url', '') <> '')),
        'header119', hdr, 'row', rw));
    n := n + 1;
  end loop;
  return jsonb_build_object('job', jid, 'queued', n, 'missing_from_drafts', missing);
end $function$


-- run_price_worker
CREATE OR REPLACE FUNCTION pipeline.run_price_worker()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'extensions', 'public'
AS $function$
declare resp extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '150000');
  resp := extensions.http(('POST','https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/price-worker',
     array[extensions.http_header('x-backup-secret', (select value from backup.config where key = 'cron_secret'))]::extensions.http_header[],
     'application/json','{}')::extensions.http_request);
  return resp.status;
exception when others then return -1;
end $function$


-- scout_bench_step
CREATE OR REPLACE FUNCTION pipeline.scout_bench_step(n integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
declare r record; t0 timestamptz; res jsonb; done int := 0;
begin
  for r in select * from pipeline.scout_bench where state = 'pending' order by id limit n for update skip locked loop
    update pipeline.scout_bench set state = 'running', started_at = now() where id = r.id;
    t0 := clock_timestamp();
    begin
      res := pipeline.scout_call(jsonb_build_object('action','evaluate','store','','cost', r.cost,
        'ident', jsonb_strip_nulls(jsonb_build_object('title', r.title, 'author', r.author, 'isbn', r.isbn,
          'format', nullif(r.fmt,''), 'weight_lb', coalesce(r.weight, 1), 'family_friendly', true,
          'search', trim(coalesce(r.title,'') || ' ' || coalesce(split_part(r.author, ',', 1), ''))))));
    exception when others then res := jsonb_build_object('ok', false, 'error', sqlerrm);
    end;
    update pipeline.scout_bench set state = 'done', finished_at = clock_timestamp(),
      ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int, result = res - 'ident' - 'prior' where id = r.id;
    done := done + 1;
  end loop;
  return done;
end $function$


-- scout_call
CREATE OR REPLACE FUNCTION pipeline.scout_call(req jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'extensions', 'public'
AS $function$
declare
  pin text;
  resp extensions.http_response;
begin
  select value into pin from backup.config where key = 'scout_pin';
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '90000');
  resp := extensions.http((
    'POST',
    'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scout',
    array[]::extensions.http_header[],
    'application/json',
    (req || jsonb_build_object('pin', pin))::text
  )::extensions.http_request);
  begin
    return resp.content::jsonb;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Scout answered ' || resp.status || ': ' || left(coalesce(resp.content, ''), 300));
  end;
end;
$function$


-- scout_lots
CREATE OR REPLACE FUNCTION pipeline.scout_lots()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(x order by x->>'last' desc), '[]'::jsonb) from (
    select jsonb_build_object('batch', batch, 'n', count(*), 'last', max(created_at),
      'LIST', count(*) filter (where pile='LIST'), 'SELL', count(*) filter (where pile='SELL'),
      'GOODWILL', count(*) filter (where pile='GOODWILL'), 'TOSS', count(*) filter (where pile='TOSS')) x
    from pipeline.cleanup_piles where created_at > now() - interval '60 days'
    group by batch order by max(created_at) desc limit 15) t
$function$


-- scout_piles
CREATE OR REPLACE FUNCTION pipeline.scout_piles(p_batch text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select jsonb_build_object('ok', true, 'rows', coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'title', p.title, 'isbn', p.isbn, 'author', p.author, 'pile', p.pile, 'pile_suggested', p.pile_suggested,
    'list_price', p.list_price::float8, 'buyback_vendor', p.buyback_vendor, 'buyback_price', p.buyback_price::float8,
    'summary', (select s.summary from pipeline.scout_scans s where s.pile_id = p.id order by s.id desc limit 1)
  ) order by p.created_at), '[]'::jsonb))
  from pipeline.cleanup_piles p where p.batch = p_batch
$function$


-- scout_trips
CREATE OR REPLACE FUNCTION pipeline.scout_trips(req jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pipeline', 'public'
AS $function$
  with b as (
    select *, coalesce(nullif(trip,''), date_bought::text || ' ' || coalesce(store,'') || ' ' || coalesce(location,'')) as tk
    from pipeline.scout_buys
  )
  select case when coalesce(req->>'trip','') = '' then
    coalesce((select jsonb_agg(t order by t->>'date' desc, t->>'trip') from (
      select jsonb_build_object('trip', tk, 'date', min(date_bought)::text, 'store', min(store), 'location', min(location),
        'books', sum(copies), 'cost', round(sum(coalesce(cost,0) * copies), 2), 'list', round(sum(coalesce(suggested_list,0) * copies), 2)) t
      from b group by tk order by min(date_bought) desc limit 60) x), '[]'::jsonb)
  else
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'isbn', isbn, 'author', author, 'cost', cost,
        'list', suggested_list, 'copies', copies, 'photo', photo_url, 'pd', pd_number, 'listed', listed) order by id)
      from b where tk = req->>'trip'), '[]'::jsonb)
  end
$function$


-- short65
CREATE OR REPLACE FUNCTION pipeline.short65(s text, is_author boolean)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare t text := btrim(coalesce(s,''));
begin
  if length(t) <= 65 then return t; end if;
  t := btrim(regexp_replace(t, '\s*\(.*$', ''));
  t := btrim(split_part(t, ';', 1));
  if length(t) > 65 then
    t := btrim(regexp_replace(t, ',\s*(also|published|with|and)\M.*$', '', 'i'));
  end if;
  if is_author and length(t) > 65 then t := btrim(split_part(t, ',', 1)) || ' et al.'; end if;
  if length(t) > 65 then t := btrim(split_part(t, ',', 1)); end if;
  if length(t) > 65 then t := btrim(left(t, 65)); end if;
  return t;
end $function$


-- station_boot
CREATE OR REPLACE FUNCTION pipeline.station_boot(p_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select jsonb_build_object(
    'kv', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from pipeline.station_kv where key not like 'zz_%'),
    'books', (select coalesce(jsonb_agg(item order by ts desc), '[]'::jsonb) from (select item, ts from pipeline.station_books
               where not coalesce((item->>'deleted')::boolean, false) order by ts desc limit p_limit) b),
    'total', (select count(*) from pipeline.station_books where not coalesce((item->>'deleted')::boolean, false)));
$function$


-- station_job
CREATE OR REPLACE FUNCTION pipeline.station_job(p_action text, p_body jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
declare jid bigint;
begin
  insert into pipeline.station_jobs(action, body) values (p_action, p_body) returning id into jid;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/station-cloud',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := jsonb_build_object('job', jid), timeout_milliseconds := 20000);
  return jid;
end $function$


-- station_jobs_get
CREATE OR REPLACE FUNCTION pipeline.station_jobs_get(p_ids bigint[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'result', result, 'age', extract(epoch from now() - created_at)::int)), '[]'::jsonb)
  from pipeline.station_jobs where id = any(p_ids);
$function$


-- station_key_follows_p
CREATE OR REPLACE FUNCTION pipeline.station_key_follows_p()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
begin
  if new.source = 'station' and new.p is not null and new.p is distinct from old.p then
    new.drive_folder_id := 'station:' || new.p;
  end if;
  return new;
end $function$


-- translit
CREATE OR REPLACE FUNCTION pipeline.translit(s text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare t text := coalesce(s,''); p text[]; pairs text[] := array[
 'Щ','Shch','щ','shch','Ж','Zh','ж','zh','Ч','Ch','ч','ch','Ш','Sh','ш','sh','Ц','Ts','ц','ts','Х','Kh','х','kh','Ю','Yu','ю','yu','Я','Ya','я','ya','Ё','Yo','ё','yo','Є','Ye','є','ye','Ї','Yi','ї','yi',
 'Й','Y','й','y','Ы','Y','ы','y','Э','E','э','e','Ъ','','ъ','','Ь','','ь','','«','"','»','"','„','"','№','No.',
 'А','A','а','a','Б','B','б','b','В','V','в','v','Г','G','г','g','Д','D','д','d','Е','E','е','e','З','Z','з','z','И','I','и','i','І','I','і','i','К','K','к','k','Л','L','л','l','М','M','м','m',
 'Н','N','н','n','О','O','о','o','П','P','п','p','Р','R','р','r','С','S','с','s','Т','T','т','t','У','U','у','u','Ф','F','ф','f'];
 i int;
begin
  if t !~ '[Ѐ-ӿ«»„№]' then return t; end if;
  i := 1; while i < array_length(pairs,1) loop t := replace(t, pairs[i], pairs[i+1]); i := i + 2; end loop;
  return t;
end $function$


-- ui_blastoff
CREATE OR REPLACE FUNCTION pipeline.ui_blastoff()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare n int; pds text; a int; c jsonb; f jsonb; hold text[]; ap jsonb; phold text[]; clean text[];
begin
  insert into pipeline.config(key, value) values ('blastoff_requested_at', now()::text)
    on conflict (key) do update set value = excluded.value;
  -- Pricing Rule v2: prices Perplexity (or Papa Duck) approved go into price_override first
  ap := pipeline.price_review_apply();
  -- family-friendly check: a flagged book he has not OK'd is held back (stays in Sent, listed in the notice)
  select coalesce(array_agg(pd || ' ' || coalesce(ident->>'title','') order by pd), '{}') into hold from pipeline.drafts
   where status = 'sent' and built_at is null and coalesce((ident->'audience'->>'ok')::boolean, true) = false and coalesce(answers->>'audience_ok','') <> 'yes';
  -- 2026-10-17 "the blast has to be complete": price-held and cleanup books are NOT skipped any more - they go out and are only named
  select coalesce(array_agg(pd || ' ' || coalesce(ident->>'title','') order by pd), '{}') into phold from pipeline.drafts d
   where status = 'sent' and built_at is null and d.price_override is null and pipeline.price_held(d.id);
  select coalesce(array_agg(pd || ' ' || coalesce(ident->>'title','') order by pd), '{}') into clean from pipeline.drafts d
   where status = 'sent' and built_at is null and d.price_override is null and coalesce(pricing->>'cleanup','') <> '';
  f := pipeline.fba_from_blastoff();
  c := pipeline.auto_clear_built();
  update pipeline.drafts set archived_at = now()
   where archived_at is null and (status in ('dont_list','failed') or (status = 'sent' and built_at is not null));
  get diagnostics a = row_count;
  select count(*), string_agg(pd, ', ' order by pd) into n, pds from pipeline.drafts d
   where status = 'sent' and built_at is null and channel <> 'fba'
     and not (coalesce((ident->'audience'->>'ok')::boolean, true) = false and coalesce(answers->>'audience_ok','') <> 'yes');
  return jsonb_build_object('ok', true, 'waiting', n, 'pds', coalesce(pds, ''), 'archived', a, 'auto_cleared', c->'cleared', 'requested_at', now(),
                            'audience_hold', to_jsonb(hold), 'sent_at_claude_price', to_jsonb(phold), 'cleanup_at_699', to_jsonb(clean),
                            'prices_applied', ap->'applied', 'grade_questions', ap->'grade_questions') || f;
end $function$


-- ui_list
CREATE OR REPLACE FUNCTION pipeline.ui_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
  -- 2026-10-06: archived (already blasted off) drafts older than 3 days are left out, and archived ones carry only a
  -- slim summary - the full list had grown to 1.9 MB and the Drafts page loaded nothing.
  select coalesce(jsonb_agg(case when archived_at is not null then jsonb_build_object(
      'id', id, 'scan', scan, 'p', p, 'p_num', p_num, 'status', status, 'is_set', is_set, 'channel', channel, 'location', location, 'source', source,
      'photos', '[]'::jsonb,
      'ident', jsonb_build_object('title', ident->'title', 'author', ident->'author', 'grade', ident->'grade', 'isbn', ident->'isbn', 'publication_year', ident->'publication_year'),
      'flags', '[]'::jsonb, 'questions', '[]'::jsonb, 'answers', '{}'::jsonb,
      'pd', pd, 'weight_lb', weight_lb, 'error', error, 'attempts', attempts,
      'pricing', jsonb_build_object('list', pricing->'list', 'auto', pricing->'auto', 'min', pricing->'min', 'ebay_title', pricing->'ebay_title'),
      'price_stale', price_stale, 'price_override', price_override, 'priced_at', priced_at,
      'etsy', etsy, 'etsy_rec', etsy_rec, 'etsy_year', null, 'amazon', null, 'amazon_at', amazon_at, 'amazon_on', amazon_on,
      'created_at', created_at, 'updated_at', updated_at, 'sent_at', sent_at, 'built_at', built_at, 'archived_at', archived_at)
    else jsonb_build_object(
      'id', id, 'scan', scan, 'p', p, 'p_num', p_num, 'status', status, 'is_set', is_set, 'channel', channel, 'location', location, 'source', source,
      'photos', photos, 'ident', ident, 'flags', flags, 'questions', questions, 'answers', answers,
      'pd', pd, 'weight_lb', weight_lb, 'error', error, 'attempts', attempts,
      'pricing', case when built_at is not null then pricing - 'dropped' - 'used' - 'market' - 'queries' else pricing end,
      'price_stale', price_stale, 'price_override', price_override, 'priced_at', priced_at,
      'etsy', etsy, 'etsy_rec', etsy_rec, 'etsy_year', pipeline.etsy_year(d),
      'amazon', amazon, 'amazon_at', amazon_at, 'amazon_on', amazon_on,
      'created_at', created_at, 'updated_at', updated_at, 'sent_at', sent_at, 'built_at', built_at, 'archived_at', archived_at) end
    order by (source = 'station') desc, case when source = 'station' then created_at end desc,
             to_date(substring(scan from '\d{6}'), 'MMDDYY') desc nulls last, (scan like '%PM') desc, p_num), '[]'::jsonb)
  from pipeline.drafts d
  where archived_at is null or archived_at > now() - interval '3 days';
$function$


-- ui_reprice_missing
CREATE OR REPLACE FUNCTION pipeline.ui_reprice_missing()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pipeline', 'extensions', 'public'
AS $function$
declare n int; k int; secret text;
begin
  with t as (
    update pipeline.drafts set price_stale = true, price_attempts = 0, price_claimed_at = null,
           updated_at = now() - interval '1 minute'
     where status in ('drafted','sent') and built_at is null and archived_at is null and ident is not null
       and price_override is null and (pricing is null or (pricing->>'list') is null)
       and not (price_stale and price_attempts < 3 and price_claimed_at > now() - interval '3 minutes')
    returning id)
  select count(*) into n from t;
  select count(*) into k from pipeline.drafts
   where status in ('drafted','sent') and built_at is null and price_stale and price_attempts < 3 and ident is not null;
  select value into secret from backup.config where key = 'cron_secret';
  for i in 1 .. least(k, 6) loop
    perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/price-worker',
      headers := jsonb_build_object('x-backup-secret', secret, 'Content-Type', 'application/json'),
      body := '{}'::jsonb, timeout_milliseconds := 150000);
  end loop;
  return jsonb_build_object('restarted', n, 'pricing', k);
end $function$


-- ui_save
CREATE OR REPLACE FUNCTION pipeline.ui_save(p_id bigint, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare d pipeline.drafts; act text := coalesce(p->>'action', 'save'); q jsonb; i int; missing text[] := '{}'; newpd text; dup text;
  stale boolean;
begin
  select * into d from pipeline.drafts where id = p_id for update;
  if not found then raise exception 'Draft % not found', p_id; end if;
  if d.built_at is not null then
    raise exception 'This book was already picked up at blast off and can no longer be changed here.';
  end if;
  if d.status = 'fba' then
    raise exception 'This book is in FBA box % - use Undo FBA on the FBA tab to change it.', (select box from pipeline.fba_items where draft_id = p_id);
  end if;
  stale := d.price_stale;

  if p ? 'answers' and coalesce(p->'answers','{}'::jsonb) is distinct from coalesce(d.answers,'{}'::jsonb) then
    d.answers := coalesce(p->'answers', '{}'::jsonb); stale := true; end if;
  if p ? 'weight_lb' then d.weight_lb := nullif(p->>'weight_lb','')::numeric; end if;
  -- Quantity (2026-10-01, Papa Duck: "need to be able to change quantity on papa duck drafts").
  if p ? 'qty' then
    if coalesce(nullif(p->>'qty','')::int, 0) < 1 or (p->>'qty')::int > 999 then raise exception 'Quantity must be a whole number from 1 to 999.'; end if;
    d.answers := jsonb_set(coalesce(d.answers,'{}'::jsonb), '{station}', coalesce(d.answers->'station','{}'::jsonb) || jsonb_build_object('qty', (p->>'qty')::int));
  end if;
  -- 2026-10-07 family-friendly check: he says "OK to list" on a flagged book (Standing Rule #6 - a flag, his decision)
  if p ? 'audience_ok' then
    d.answers := coalesce(d.answers,'{}'::jsonb) || jsonb_build_object('audience_ok', case when (p->>'audience_ok')::boolean then 'yes' else '' end);
  end if;
  if p ? 'ident' and (coalesce(d.ident,'{}'::jsonb) || (p->'ident')) is distinct from d.ident then
    d.ident := coalesce(d.ident, '{}'::jsonb) || (p->'ident'); stale := true; end if;
  if p ? 'price_override' then
    d.price_override := nullif(regexp_replace(coalesce(p->>'price_override',''), '[^0-9.]', '', 'g'), '')::numeric;
    if d.price_override is not null and d.price_override <= 0 then d.price_override := null; end if;
  end if;
  if p ? 'location' then
    if p->>'location' not in ('Garage','Storage','Office') then raise exception 'Unknown location %', p->>'location'; end if;
    d.location := p->>'location';
  end if;
  if p ? 'channel' then
    -- 2026-10-07: 'fba' = Amazon FBA only; goes out at blast off (pipeline.fba_from_blastoff), never in the files
    if p->>'channel' not in ('both','ebay','abe','amazon','fba') then raise exception 'Unknown channel %', p->>'channel'; end if;
    d.channel := p->>'channel';
  end if;
  -- Etsy is OPT-IN (Papa Duck 2026-09-29): he switches it on himself; only 20+ year old books with a confirmed year.
  if p ? 'etsy' then
    if (p->>'etsy')::boolean then
      if d.channel in ('amazon','fba') then raise exception 'Amazon-only and FBA books do not go to Etsy.'; end if;
      if pipeline.etsy_year(d) is null then raise exception 'Etsy needs a confirmed year, and this book has none. Add the year in Details first (Etsy only takes books 20+ years old).'; end if;
      if pipeline.etsy_year(d) > extract(year from now())::int - 20 then raise exception 'Too new for Etsy: % is under 20 years old. Etsy only takes vintage (% or older).', pipeline.etsy_year(d), extract(year from now())::int - 20; end if;
    end if;
    d.etsy := (p->>'etsy')::boolean;
  end if;
  -- Amazon (2026-10-01): null = automatic (listed when Amazon fit is Good), true/false = his choice. Never ON when restricted.
  if p ? 'amazon_on' then
    if p->>'amazon_on' is null or p->>'amazon_on' = '' then d.amazon_on := null;
    else
      if (p->>'amazon_on')::boolean and coalesce(d.amazon->>'status','') <> 'ok' then
        raise exception 'Amazon is locked for this book: %', case coalesce(d.amazon->>'status','') when 'restricted' then 'your account is restricted for it' when 'not_on_amazon' then 'Amazon has no page for it' else 'it has not been checked against Amazon yet' end;
      end if;
      d.amazon_on := (p->>'amazon_on')::boolean;
    end if;
  end if;
  if p ? 'pd' then
    newpd := upper(regexp_replace(coalesce(p->>'pd',''), '\s', '', 'g'));
    if newpd ~ '^\d{3,4}[A-Z]?$' then newpd := 'PD-' || lpad(regexp_replace(newpd,'[A-Z]$',''), 4, '0') || coalesce(substring(newpd from '[A-Z]$'),''); end if;
    if newpd ~ '^PD\d' then newpd := 'PD-' || substring(newpd from 3); end if;
    d.pd := nullif(newpd, '');
  end if;
  if p ? 'photo_order' then
    if jsonb_array_length(coalesce(p->'photo_order','[]'::jsonb)) = 0 then
      raise exception 'Keep at least one photo — a listing needs a cover.';
    end if;
    select coalesce(jsonb_agg(
             (ph - 'removed') || case when o.ord is null then jsonb_build_object('removed', true) else '{}'::jsonb end
             order by (o.ord is null), coalesce(o.ord, 999), (ph->>'n')::int), '[]'::jsonb) into d.photos
    from jsonb_array_elements(d.photos) ph
    left join (select v #>> '{}' as drive_id, ord from jsonb_array_elements(p->'photo_order') with ordinality as t(v, ord)) o
      on o.drive_id = ph->>'drive_id';
  end if;

  if act = 'send' then
    if d.status = 'dont_list' then raise exception 'This book is marked not for listing. Move it back to To check first.'; end if;
    if d.channel not in ('both','ebay','abe','amazon','fba') then raise exception 'Pick where it goes: eBay + AbeBooks, eBay only, AbeBooks only, Amazon only or Amazon FBA.'; end if;
    if d.pd is null or d.pd !~ '^PD-\d{4}[A-Z]?$' then missing := array_append(missing, 'PD number (like PD-2940)'); end if;
    if d.weight_lb is null or d.weight_lb <= 0 then missing := array_append(missing, 'weight'); end if;
    if d.price_override is null and coalesce(d.pricing->>'list','') = '' then
      if d.pricing ? 'error' then missing := array_append(missing, 'a price (no matching copies were found — type your price)');
      else missing := array_append(missing, 'the price (still being worked out — give it a minute)'); end if;
    end if;
    -- family-friendly check (2026-10-07): must have run; a flagged book needs his OK
    if d.ident->'audience' is null then missing := array_append(missing, 'the family-friendly check (runs on its own, about a minute)');
    elsif coalesce((d.ident->'audience'->>'ok')::boolean, false) = false and coalesce(d.answers->>'audience_ok','') <> 'yes' then
      missing := array_append(missing, 'your OK on the ⚠️ family-friendly flag: ' || coalesce(d.ident->'audience'->>'note','') || ' (press OK to list, or Don''t list)');
    end if;
    if d.channel = 'fba' then
      if coalesce(d.amazon->>'status','') <> 'ok' or coalesce(d.amazon->>'asin','') !~ '^[0-9A-Z]{10}$' then
        missing := array_append(missing, 'an Amazon page you can sell on (FBA) - ' || case coalesce(d.amazon->>'status','') when 'restricted' then 'restricted in this condition'
          when 'not_on_amazon' then 'not on Amazon' when '' then 'not checked yet' else 'Amazon check failed' end);
      end if;
      if coalesce((d.answers->'station'->>'qty')::int, 1) <> 1 then missing := array_append(missing, 'quantity 1 for FBA (one sticker per book)'); end if;
      if coalesce(d.ident->>'grade','') not in ('Like New','Very Good','Good','Acceptable','Brand New','New') then missing := array_append(missing, 'a grade'); end if;
    end if;
    i := 0;
    for q in select * from jsonb_array_elements(d.questions) loop
      if coalesce(trim(d.answers->>(i::text)), '') = '' then missing := array_append(missing, 'answer to: ' || (q->>'q')); end if;
      i := i + 1;
    end loop;
    if coalesce(array_length(missing, 1), 0) > 0 then raise exception 'Not ready to send. Still needed: %', array_to_string(missing, '; '); end if;
    select p2.scan || ' ' || p2.p into dup from pipeline.drafts p2 where p2.pd = d.pd and p2.id <> d.id and p2.status <> 'dont_list' limit 1;
    if dup is not null then raise exception '% is already used on %. A PD number belongs to one book.', d.pd, dup; end if;
    d.status := 'sent'; d.sent_at := now();
  elsif act in ('dont_list','goodwill','trash') then
    d.status := 'dont_list'; d.channel := act; d.sent_at := null;
  elsif act = 'reopen' then
    d.status := 'drafted'; d.sent_at := null;
    if d.channel in ('goodwill','trash','dont_list') then d.channel := 'both'; end if;
  elsif act = 'reprice' then
    stale := true;
  end if;

  if d.channel = 'fba' then d.etsy := false; d.amazon_on := false; end if;
  update pipeline.drafts set answers = d.answers, weight_lb = d.weight_lb, ident = d.ident, pd = d.pd, photos = d.photos,
         channel = d.channel, location = d.location, etsy = d.etsy, amazon_on = d.amazon_on, status = d.status, sent_at = d.sent_at, price_override = d.price_override,
         price_stale = stale, price_attempts = case when stale and not d.price_stale then 0 else price_attempts end,
         updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', d.status, 'pd', d.pd, 'channel', d.channel, 'etsy', d.etsy, 'amazon_on', d.amazon_on);
end $function$
