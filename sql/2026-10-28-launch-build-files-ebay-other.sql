-- 2026-10-28 NON-BOOK items get their own run: "eBay Other" (jobs.ebay_other). Items never go to AbeBooks, Etsy (until item Etsy is built) or Amazon.
-- Books: unchanged - same rows, same eBay job, same AbeBooks / Etsy / Amazon steps.
CREATE OR REPLACE FUNCTION pipeline.launch_build_files(p_nid bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare n pipeline.launch_nights; dry boolean; nt text; tag text; g int; ng int; jid bigint; f text; nm text; lo text; hi text;
  ebay jsonb; ebay_o jsonb; abe_ids bigint[] := '{}'; etsy_id bigint; amz_id bigint; cnt int; i_n int; e_n int; a_n int;
begin
  select * into n from pipeline.launch_nights where id = p_nid for update;
  dry := n.status like 'dry%'; nt := n.night; tag := regexp_replace(nt, '-(dry|L).*$', '');
  create temp table lb_rows on commit drop as
    select * from pipeline.blast_rows(nt) r
     where r.pd = any(n.pds) and r.pd not in (select pd from pipeline.launch_reconsider where night_id = p_nid and answer in ('hold','dont_list'));
  -- non-book items come out of the book rows into their own run
  create temp table lb_items on commit drop as select * from lb_rows where ident->>'kind' = 'item';
  delete from lb_rows where ident->>'kind' = 'item';
  select count(*) into i_n from lb_items;
  select count(*), min(pd), max(pd) into cnt, lo, hi from lb_rows;
  if cnt = 0 and i_n = 0 then return jsonb_build_object('ok', false, 'error', 'No books with listing details for this night.'); end if;

  -- Step 1: eBay (same item shape as the 10/22 and 10/24 hand builds)
  if cnt > 0 then
  select pipeline.queue_ebay((case when dry then 'DRY ' else '' end) || 'PapaDuck_eBay_PD' || substr(lo,4) || '_to_PD' || substr(hi,4) || '_' || tag,
    jsonb_agg(jsonb_build_object('pd', pd, 'cat', '261186', 'store', m->>'store_id', 'cid', cid, 'lst', lst, 'mn', case when mn >= least(auto, lst) or auto >= lst then least(round(lst*0.72*2)/2, round(lst*0.8*2)/2, round(lst-0.5,2)) else mn end,
        'auto', case when auto >= lst then least(round(lst*0.8*2)/2, round(lst-0.5,2)) else auto end, 'qty', qty, 'wmaj', wmaj,
      'title', left(pricing->>'ebay_title', 80),
      'specs', jsonb_strip_nulls(jsonb_build_object('Type','Book','Genre',m->>'genre','Topic',m->>'topic','Author',coalesce(nullif(author,''),'Unknown'),
        'Format', case when ident->>'format' ilike '%hard%' then 'Hardcover' else 'Paperback' end,
        'Signed', case when (m->>'signed')::boolean then 'Yes' else 'No' end,
        'Vintage', case when coalesce(nullif(m->>'year',''),'1900')::int <= 2000 then 'Yes' else 'No' end,
        'Language', m->>'lang', 'Ex Libris', case when (m->>'exlib')::boolean then 'Yes' end,
        'Publisher', publisher, 'Book Title', booktitle, 'Narrative Type', m->>'narrative', 'Publication Year', nullif(m->>'year','')))) order by pd), false)
    into ebay from lb_rows;
  end if;

  -- Step 1b: eBay Other - non-book items: eBay's own category + item specifics, condition Used (3000), Calculated Package shipping policy
  if i_n > 0 then
  select pipeline.queue_ebay((case when dry then 'DRY ' else '' end) || 'PapaDuck_eBay_Other_PD' || substr(min(pd),4) || '_to_PD' || substr(max(pd),4) || '_' || tag,
    jsonb_agg(jsonb_build_object('pd', pd, 'kind', 'item', 'cat', pricing->'item'->>'category_id', 'store', null,
      'cid', coalesce((pricing->'item'->>'cond_id')::int, 3000), 'lst', lst,
      'mn', case when mn >= least(auto, lst) or auto >= lst then least(round(lst*0.72*2)/2, round(lst*0.8*2)/2, round(lst-0.5,2)) else mn end,
      'auto', case when auto >= lst then least(round(lst*0.8*2)/2, round(lst-0.5,2)) else auto end, 'qty', qty, 'wmaj', wmaj,
      'title', left(pricing->>'ebay_title', 80),
      'ship_policy', coalesce((select value from backup.config where key = 'ebay_item_ship_policy'), '273381986020'),
      'specs', coalesce(pricing->'item'->'specifics', '{}'::jsonb)) order by pd), false)
    into ebay_o from lb_items;
  end if;

  -- Step 2: AbeBooks, files of 13 books or fewer (books only)
  ng := ceil(cnt / 13.0);
  for g in 1..ng loop
    with b as (select *, ntile(ng) over (order by pd) grp from lb_rows),
    s as (select b.*, (select string_agg(ph->>'url',' ' order by o) from jsonb_array_elements(b.photos) with ordinality t(ph,o)
             where coalesce((ph->>'removed')::boolean,false)=false and coalesce(ph->>'url','')<>'') urls from b where grp = g)
    select min(pd), max(pd),
      array_to_string(array['listingid','title','author','illustrator','price','quantity','producttype','description','bindingtext','bookcondition','publishername','placepublished','yearpublished','isbn','sellercatalog1','sellercatalog2','sellercatalog3','abecategory','keywords','jacketcondition','editiontext','printingtext','signedtext','volume','size','imgurl','weight','weightunit','shippingtemplateid','language'], E'\t') || E'\n' ||
      string_agg(array_to_string(array[pd, pipeline.abe_clean(pipeline.translit_ro(booktitle)), pipeline.abe_clean(pipeline.translit_ro(coalesce(nullif(author,''),'Unknown'))), '', lst::text, qty::text, 'Book', pipeline.abe_clean(pipeline.translit_ro(pricing->>'b1')),
        case when ident->>'format' ilike '%hard%' then 'Hardcover' else 'Softcover' end,
        case ident->>'grade' when 'Like New' then 'As New' when 'Brand New' then 'New' when 'Acceptable' then 'Fair' else coalesce(ident->>'grade','Good') end,
        pipeline.abe_clean(pipeline.translit_ro(publisher)), '', coalesce(m->>'year',''), '', pipeline.abe_clean(m->>'store_name'), '', '', '', pipeline.abe_clean(m->>'keywords'),
        '', '', '', case when (m->>'signed')::boolean then 'Signed' else '' end, '', '', urls, wmaj::text, 'POUNDS', 'ST-00001',
        case m->>'lang' when 'Russian' then 'RUS' when 'German' then 'GER' when 'Hungarian' then 'HUN' when 'Spanish' then 'SPA' when 'French' then 'FRE' when 'Latin' then 'LAT' when 'Italian' then 'ITA' else 'ENG' end], E'\t'), E'\n' order by pd)
    into lo, hi, f from s;
    nm := (case when dry then 'DRY ' else '' end) || 'PapaDuck_AbeBooks_Add_PD' || substr(lo,4) || '_to_PD' || substr(hi,4) || '_' || tag;
    insert into pipeline.send_jobs(channel, name, status, data_file, data_name, data_state, night)
      values ('abe', nm, 'ready', f, replace(nm,'DRY ','') || '.txt', 'waiting', nt) returning id into jid;
    abe_ids := abe_ids || jid;
    insert into pipeline.send_items(job_id, pd, seq, payload, names)
      select jid, pd, row_number() over (order by pd), jsonb_build_object('urls', ua, 'title', booktitle),
        (select jsonb_agg(pd || '_' || o || '.jpg' order by o) from jsonb_array_elements(ua) with ordinality t(u,o))
      from (select b.*, (select jsonb_agg(ph->>'url' order by o) from jsonb_array_elements(b.photos) with ordinality t(ph,o)
             where coalesce((ph->>'removed')::boolean,false)=false and coalesce(ph->>'url','')<>'') ua
            from (select *, ntile(ng) over (order by pd) grp from lb_rows) b where grp = g) x;
  end loop;

  -- Step 3: Etsy, with its 13 tags (books only for now)
  select count(*) into e_n from lb_rows where etsy;
  if e_n > 0 then
    insert into pipeline.send_jobs(channel, name, status, night)
      values ('etsy', (case when dry then 'DRY ' else '' end) || 'PapaDuck_Etsy_PD' || (select substr(min(pd),4) || '_to_PD' || substr(max(pd),4) from lb_rows where etsy) || '_' || tag, 'ready', nt) returning id into etsy_id;
    insert into pipeline.send_items(job_id, pd, seq, payload, names)
      select etsy_id, pd, row_number() over (order by pd), jsonb_build_object('sku',pd,'price',lst::text,'title',left(regexp_replace(pricing->>'ebay_title', '^[^A-Za-z0-9]+', ''),140),'section',m->>'etsy_section',
        'pub_year',coalesce(m->>'year',''),'quantity',qty::text,'when_made',m->>'when_made',
        'image_urls',(select jsonb_agg(u order by o) from (select ph->>'url' u, o from jsonb_array_elements(photos) with ordinality t(ph,o)
              where coalesce((ph->>'removed')::boolean,false)=false and coalesce(ph->>'url','')<>'' order by o limit 20) z),
        'description',pipeline.etsy_plain(pricing->>'b2'),'taxonomy_id',m->>'etsy_tax',
        'shipping_profile_id', case when coalesce(weight_lb,1)<=1 then '311855277605' when weight_lb<=2 then '312059762493' when weight_lb<=5 then '311987833328' else '311987874784' end),
        '[]'::jsonb from lb_rows where etsy;
    if not dry then
      insert into pipeline.etsy_tags(pd,tags,status) select pd, m->'tags', 'pending' from lb_rows where etsy
        on conflict (pd) do update set tags=excluded.tags, status='pending', listing_id=null;
    end if;
  end if;

  -- Step 4: Amazon (edition questions already answered on the Launch Pad; books only)
  select count(*) into a_n from lb_rows where amz_will;
  if a_n > 0 then
    insert into pipeline.send_jobs(channel, name, status, night)
      values ('amazon', (case when dry then 'DRY ' else '' end) || 'PapaDuck_Amazon_PD' || (select substr(min(pd),4) || '_to_PD' || substr(max(pd),4) from lb_rows where amz_will) || '_' || tag, 'ready', nt) returning id into amz_id;
    insert into pipeline.send_items(job_id,pd,seq,payload,names)
      select amz_id, pd, row_number() over (order by pd), jsonb_build_object('fit',amazon->>'fit','sku',pd,'asin',amazon->>'asin','cond',amazon->>'cond','note',left(pipeline.abe_clean(pricing->>'b1'),1900),
        'cover',(select ph->>'url' from jsonb_array_elements(photos) with ordinality t(ph,o) where coalesce((ph->>'removed')::boolean,false)=false and coalesce(ph->>'url','')<>'' order by o limit 1),
        'price',lst,'title',booktitle,'quantity',qty,'product_type','ABIS_BOOK'), jsonb_build_array('ASIN '||(amazon->>'asin')) from lb_rows where amz_will;
  end if;

  if dry then update pipeline.send_jobs set status = 'dry' where id = any(array[(ebay->>'job')::bigint, (ebay_o->>'job')::bigint, etsy_id, amz_id] || abe_ids); end if;
  update pipeline.launch_nights set jobs = jsonb_build_object('ebay', (ebay->>'job')::bigint, 'ebay_other', (ebay_o->>'job')::bigint, 'abe', to_jsonb(abe_ids), 'etsy', etsy_id, 'amazon', amz_id),
    status = case when dry then 'dry_built' else 'ready_to_send' end, updated_at = now() where id = p_nid;
  if not dry then perform pipeline.launch_airtable(p_nid); end if;  -- Rule BS: Airtable records before anything is sent
  return jsonb_build_object('ok', true, 'books', cnt, 'items', i_n, 'ebay', ebay, 'ebay_other', ebay_o, 'abe_files', ng, 'etsy', e_n, 'amazon', a_n);
end $function$;

-- Airtable records for the eBay Other run too (Rule BS)
CREATE OR REPLACE FUNCTION pipeline.launch_airtable(p_nid bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare n pipeline.launch_nights; b jsonb; rid bigint;
begin
  select * into n from pipeline.launch_nights where id = p_nid;
  select jsonb_object_agg(i.pd, jsonb_build_object(
      'store', case when d.ident->>'kind' = 'item' then 'Non-book item' else m.m->>'store_name' end,
      'author', case when d.ident->>'kind' = 'item' then nullif(d.ident->'item'->>'maker','') else coalesce(nullif(d.ident->>'author',''), d.ident->>'publisher') end,
      'publisher', case when d.ident->>'kind' = 'item' then null else d.ident->>'publisher' end, 'year', coalesce(m.m->>'year',''),
      'lst', (i.payload->>'lst')::numeric, 'auto', (i.payload->>'auto')::numeric, 'mn', (i.payload->>'mn')::numeric,
      'note', 'Launch Pad night ' || n.night || case when d.ident->>'kind' = 'item' then ' (eBay Other)' else '' end)) into b
    from pipeline.send_items i
    join pipeline.blast_meta m on m.pd = i.pd and m.night = n.night
    join lateral (select * from pipeline.drafts d where d.pd = i.pd order by id desc limit 1) d on true
   where i.job_id in ((n.jobs->>'ebay')::bigint, (n.jobs->>'ebay_other')::bigint);
  if b is null then return null; end if;
  select net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/airtable-records',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := jsonb_build_object('books', b), timeout_milliseconds := 150000) into rid;
  return rid;
end $function$;
