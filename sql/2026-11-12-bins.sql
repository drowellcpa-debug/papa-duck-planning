-- 2026-11-12 Papa Duck: "from now on ... add Bin#" - helpers sort books into small plastic bins (15-20 books each),
-- not in PD order. The PD# stays; each LIST book also gets the bin it went into.
-- cleanup_piles.bin is set by station-api "sticker" (Sorting page); it copies to the draft with the same PD and on to Airtable "Bin".
alter table pipeline.cleanup_piles add column if not exists bin int;
alter table pipeline.drafts add column if not exists bin int;
alter table pipeline.drafts add column if not exists bin_synced boolean not null default false;
insert into pipeline.config(key, value) values ('bin_cap', '18') on conflict (key) do nothing;

-- draft gets its bin from the sticker when its PD is set
create or replace function pipeline.drafts_bin_fill() returns trigger language plpgsql as $$
begin
  if new.pd is not null and new.bin is null then
    select c.bin into new.bin from pipeline.cleanup_piles c where c.bin is not null and upper(c.pd) = upper(new.pd) order by c.id desc limit 1;
    if new.bin is not null then new.bin_synced := false; end if;
  end if;
  return new;
end $$;
drop trigger if exists drafts_bin_fill on pipeline.drafts;
create trigger drafts_bin_fill before insert or update of pd on pipeline.drafts for each row execute function pipeline.drafts_bin_fill();

-- a bin set or fixed on the Sorting page flows to the draft
create or replace function pipeline.piles_bin_push() returns trigger language plpgsql as $$
begin
  if new.pd is not null and new.bin is not null and (new.bin is distinct from old.bin or new.pd is distinct from old.pd) then
    update pipeline.drafts set bin = new.bin, bin_synced = false where upper(pd) = upper(new.pd) and bin is distinct from new.bin;
  end if;
  return new;
end $$;
drop trigger if exists piles_bin_push on pipeline.cleanup_piles;
create trigger piles_bin_push after update of bin, pd on pipeline.cleanup_piles for each row execute function pipeline.piles_bin_push();

-- how full is a bin (books stickered into it)
create or replace function pipeline.bin_status(b int default null) returns jsonb language sql stable as $$
  with cur as (select coalesce(b, (select max(bin) from pipeline.cleanup_piles), 1) n)
  select jsonb_build_object('bin', cur.n, 'n', (select count(*) from pipeline.cleanup_piles c where c.bin = cur.n),
    'cap', coalesce((select value::int from pipeline.config where key = 'bin_cap'), 18)) from cur $$;

-- Airtable "Bin" (fldFkj3kVpvAowhKd): written once the Airtable record exists (records are made at send time)
create or replace function pipeline.airtable_bin_sync() returns jsonb language plpgsql set search_path to 'pipeline','pg_catalog' as $$
declare r record; tok text; res extensions.http_response; rec text; n int := 0; miss int := 0;
begin
  select (decrypted_secret::jsonb)->'airtable'->>'token' into tok from vault.decrypted_secrets where name = 'papaduck_keys';
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','20000');
  for r in select * from (select distinct on (upper(pd)) id, upper(pd) pd, bin from pipeline.drafts
           where bin is not null and not bin_synced and pd is not null order by upper(pd), id desc) x order by random() limit 15 loop
    res := extensions.http(('GET', 'https://api.airtable.com/v0/appdMXzb9U4sdXpAr/tblKxgB4q7v9SPqze?returnFieldsByFieldId=true&fields%5B%5D=fldxiwKYi6z1t0iDx&filterByFormula='
             || extensions.urlencode(format('{Tracking Number}=''%s''', r.pd)),
             array[extensions.http_header('Authorization', 'Bearer ' || tok)], null, null)::extensions.http_request);
    rec := case when res.status = 200 then (res.content::jsonb)->'records'->0->>'id' end;
    if rec is null then miss := miss + 1; continue; end if;
    res := extensions.http(('PATCH', 'https://api.airtable.com/v0/appdMXzb9U4sdXpAr/tblKxgB4q7v9SPqze',
             array[extensions.http_header('Authorization', 'Bearer ' || tok)], 'application/json',
             jsonb_build_object('records', jsonb_build_array(jsonb_build_object('id', rec, 'fields', jsonb_build_object('fldFkj3kVpvAowhKd', r.bin))))::text)::extensions.http_request);
    if res.status = 200 then update pipeline.drafts set bin_synced = true where upper(pd) = r.pd; n := n + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'written', n, 'no_record_yet', miss);
end $$;
select cron.schedule('pd-airtable-bin-sync', '*/15 * * * *', $$select pipeline.airtable_bin_sync()$$);
