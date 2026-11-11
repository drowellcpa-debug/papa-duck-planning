-- 2026-11-11 Papa Duck: "when I start sending them there can you start building lots based on genre, cd, etc, and put them in their
-- pre-assigned V number so that when I get the cd actually processed I will know what bag to put it in" + "when the lot is too big, then
-- add it to another V number". -> Every item sent to the 🛍️ Vinted box is sorted (edge fn vinted-sort: format + genre) into an open bag
-- (vinted_lots status 'filling') of the same group; a full bag starts the next V-number. The Quick check shows the bag right away.
alter table pipeline.cleanup_piles add column if not exists vgroup text;
alter table pipeline.vinted_lots add column if not exists vgroup text, add column if not exists cap int;

insert into pipeline.config(key, value) values ('vinted_bag_caps',
  '{"CDs":8,"Cassettes":8,"8-tracks":5,"Vinyl records":4,"VHS":6,"DVDs":8,"Books":6}')
on conflict (key) do nothing;

-- put one item in the right bag (open bag of its group with room, else a new V-number)
create or replace function pipeline.vinted_assign(p_pile bigint, p_group text)
returns jsonb language plpgsql as $$
declare c record; l record; cap int; fmt text := split_part(p_group, ' · ', 1); lid bigint; n int;
begin
  select * into c from pipeline.cleanup_piles where id = p_pile for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'no such item'); end if;
  if c.vinted_lot is not null then
    select * into l from pipeline.vinted_lots where id = c.vinted_lot;
    return jsonb_build_object('ok', true, 'id', l.id, 'vnum', l.vnum, 'group', l.vgroup, 'n', coalesce(array_length(l.items,1),0), 'cap', l.cap);
  end if;
  cap := coalesce((select (value::jsonb->>fmt)::int from pipeline.config where key = 'vinted_bag_caps'), 6);
  select * into l from pipeline.vinted_lots where status = 'filling' and vgroup = p_group and coalesce(array_length(items,1),0) < coalesce(cap, 6)
    order by id limit 1 for update;
  if l.id is null then
    insert into pipeline.vinted_lots(items, photos, title, description, category, condition, package, price, status, vgroup, cap)
      values ('{}', '{}', p_group || ' (bag filling)', '', case when fmt = 'Books' then 'Entertainment > Books' when fmt in ('VHS','DVDs') then 'Entertainment > Video' else 'Entertainment > Music' end,
              'Good', 'Medium', 0, 'filling', p_group, cap)
      returning * into l;
  end if;
  update pipeline.vinted_lots set items = items || p_pile where id = l.id returning coalesce(array_length(items,1),0) into n;
  update pipeline.cleanup_piles set vinted_lot = l.id, vgroup = p_group where id = p_pile;
  return jsonb_build_object('ok', true, 'id', l.id, 'vnum', l.vnum, 'group', p_group, 'n', n, 'cap', l.cap, 'full', n >= l.cap);
end $$;

-- bag ready to list: gather every item's photos (full Book Station photos once matched), price, package -> lot 'draft'
create or replace function pipeline.vinted_lot_ready(p_id bigint)
returns jsonb language plpgsql as $$
declare r record; n int := 0; pr numeric := 0; ph text[] := '{}'; l record;
begin
  select * into l from pipeline.vinted_lots where id = p_id;
  for r in select * from pipeline.cleanup_piles where id = any(l.items) order by array_position(l.items, id) loop
    n := n + 1;
    pr := pr + greatest(2, coalesce(r.list_price, 0) * 0.35);
    if coalesce(array_length(r.photos, 1), 0) > 0 then ph := ph || r.photos; elsif coalesce(r.photo_url, '') <> '' then ph := ph || r.photo_url; end if;
  end loop;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'This bag is empty'); end if;
  if n > 1 then pr := pr * 0.85; end if;
  update pipeline.vinted_lots set photos = ph, price = case when coalesce(price,0) = 0 then greatest(5, round(pr)) else price end,
    package = case when n <= 2 then 'Small' when n <= 6 then 'Medium' else 'Large' end,
    title = case when title like '%(bag filling)' then coalesce(vgroup, 'Lot') || ' - lot of ' || n else title end,
    status = 'draft' where id = p_id;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- take one item out of a bag (it stays in the box, unsorted, so it isn't re-bagged automatically)
create or replace function pipeline.vinted_lot_remove(p_id bigint, p_pile bigint)
returns jsonb language plpgsql as $$
begin
  update pipeline.vinted_lots set items = array_remove(items, p_pile) where id = p_id;
  update pipeline.cleanup_piles set vinted_lot = null, vgroup = 'manual' where id = p_pile and vinted_lot = p_id;
  update pipeline.vinted_lots set status = 'gone' where id = p_id and coalesce(array_length(items,1),0) = 0 and status in ('filling','draft');
  return jsonb_build_object('ok', true);
end $$;

-- break up: items back in the box, marked manual so the sorter leaves them for him to pick
create or replace function pipeline.vinted_lot_save(p_id bigint, p jsonb)
returns jsonb language plpgsql as $$
begin
  if coalesce((p->>'break')::boolean, false) then
    update pipeline.cleanup_piles set vinted_lot = null, vgroup = 'manual' where vinted_lot = p_id;
    update pipeline.vinted_lots set status = 'gone' where id = p_id;
    return jsonb_build_object('ok', true, 'broken', true);
  end if;
  update pipeline.vinted_lots set
    title = coalesce(p->>'title', title), description = coalesce(p->>'description', description), category = coalesce(p->>'category', category),
    condition = coalesce(p->>'condition', condition), package = coalesce(p->>'package', package),
    price = coalesce(nullif(p->>'price','')::numeric, price),
    photos = case when p ? 'photos' then array(select jsonb_array_elements_text(p->'photos')) else photos end,
    status = coalesce(p->>'status', status),
    listed_at = case when p->>'status' = 'listed' then now() else listed_at end,
    sold_at = case when p->>'status' = 'sold' then now() else sold_at end
  where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- the box: unsorted items + bags (filling) + lots; bag rows carry their items' titles
create or replace function pipeline.vinted_box()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'author', author, 'isbn', isbn, 'value', list_price, 'photo', photo_url, 'photos', coalesce(photos, case when photo_url is not null then array[photo_url] end), 'draft', draft_id,
                'media', (title ~* '8[- ]?track|cassette|\mcds?\M|vinyl|\mlp\M|record|vhs|dvd|tape'), 'at', created_at) order by created_at desc)
               from pipeline.cleanup_piles where pile = 'VINTED' and vinted_lot is null), '[]'),
    'lots', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('item_rows',
                (select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'value', c.list_price, 'photo', c.photo_url, 'draft', c.draft_id) order by array_position(l.items, c.id)) from pipeline.cleanup_piles c where c.id = any(l.items)))
               order by l.id desc) from pipeline.vinted_lots l where l.status <> 'gone' and (l.status <> 'listed' or l.listed_at > now() - interval '3 days')), '[]'));
$$;

-- items that arrive any other way (Drafts 🛍️ button, auto-routes) get sorted by cron
create or replace function pipeline.vinted_sort_run()
returns jsonb language plpgsql as $$
declare r extensions.http_response;
begin
  if not exists (select 1 from pipeline.cleanup_piles where pile = 'VINTED' and vinted_lot is null and vgroup is null) then return '{"ok":true,"n":0}'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '90000');
  r := extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/vinted-sort',
        array[extensions.http_header('x-backup-secret', (select value from backup.config where key = 'cron_secret'))],
        'application/json', '{}')::extensions.http_request);
  return coalesce(r.content::jsonb, jsonb_build_object('ok', false, 'status', r.status));
exception when others then return jsonb_build_object('ok', false, 'error', left(sqlerrm, 200));
end $$;

-- match the later full-photo draft even when the Quick check item is already in a bag
create or replace function pipeline.vinted_match()
returns integer language plpgsql as $$
declare d record; c record; n int := 0;
begin
  for d in select * from pipeline.drafts where status in ('drafted','sent') and built_at is null and archived_at is null
             and coalesce(channel,'') <> 'vinted' and created_at > now() - interval '2 days' and coalesce(ident->>'title','') <> '' loop
    select * into c from pipeline.cleanup_piles x
      where x.pile = 'VINTED' and x.draft_id is null
        and x.created_at between d.created_at - interval '14 days' and d.created_at
        and ((coalesce(x.isbn,'') <> '' and regexp_replace(upper(x.isbn),'[^0-9X]','','g') = regexp_replace(upper(coalesce(d.ident->>'isbn','')),'[^0-9X]','','g'))
             or (length(coalesce(x.title,'')) >= 6 and
                 left(regexp_replace(regexp_replace(lower(x.title),'^(the|a|an) ',''),'[^a-z0-9]','','g'),16)
               = left(regexp_replace(regexp_replace(lower(d.ident->>'title'),'^(the|a|an) ',''),'[^a-z0-9]','','g'),16)))
      order by x.id desc limit 1;
    if c.id is not null then
      update pipeline.cleanup_piles set draft_id = d.id where id = c.id;
      update pipeline.drafts set status = 'dont_list', channel = 'vinted',
        answers = coalesce(answers,'{}'::jsonb) || jsonb_build_object('qc_checked','vinted box','vinted_pile', c.id) where id = d.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- reopening a Vinted draft also takes it out of its bag (if the bag isn't listed yet)
create or replace function pipeline.drafts_to_vinted()
returns trigger language plpgsql security definer as $$
declare urls text[]; pid bigint; c record;
begin
  if new.channel = 'vinted' and old.channel is distinct from 'vinted' then
    select array_agg(ph->>'url' order by o) into urls from jsonb_array_elements(coalesce(new.photos,'[]'::jsonb)) with ordinality t(ph,o)
      where coalesce((ph->>'removed')::boolean,false) = false and coalesce(ph->>'url','') <> '';
    select id into pid from pipeline.cleanup_piles where draft_id = new.id limit 1;
    if pid is null then
      insert into pipeline.cleanup_piles(batch, title, author, isbn, pile, list_price, photo_url, photos, draft_id)
        values ('Drafts ' || coalesce(new.pd,''), coalesce(new.ident->>'title', new.pd), new.ident->>'author', new.ident->>'isbn', 'VINTED',
                coalesce(new.price_override, nullif(new.pricing->>'list','')::numeric), urls[1], urls, new.id);
    else
      update pipeline.cleanup_piles set pile = 'VINTED', photos = urls, photo_url = coalesce(urls[1], photo_url),
        title = coalesce(new.ident->>'title', title) where id = pid;
    end if;
  elsif old.channel = 'vinted' and new.channel is distinct from 'vinted' then
    for c in select x.id, x.vinted_lot from pipeline.cleanup_piles x join pipeline.vinted_lots l on l.id = x.vinted_lot
               where x.draft_id = new.id and l.status in ('filling','draft') loop
      perform pipeline.vinted_lot_remove(c.vinted_lot, c.id);
    end loop;
    update pipeline.cleanup_piles set pile = 'LIST' where draft_id = new.id and vinted_lot is null;
  end if;
  return new;
end $$;

select cron.schedule('pd-vinted-sort', '*/2 * * * *', $$select pipeline.vinted_sort_run()$$);
