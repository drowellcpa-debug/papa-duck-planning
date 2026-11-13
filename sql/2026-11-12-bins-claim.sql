-- 2026-11-12 Papa Duck: "I will be sorting as well but I use the book station app, can you have the bin# there as well,
-- but always give me a new one so I dont overlap". One shared numbering line: whoever needs a new bin gets the next unused number.
create table if not exists pipeline.bin_claims (bin int primary key, who text not null, at timestamptz not null default now());
alter table pipeline.bin_claims enable row level security;

create or replace function pipeline.bin_new(p_who text, p_from int default null) returns jsonb language plpgsql as $$
declare b int;
begin
  perform pg_advisory_xact_lock(7342077);
  -- the same person's bin filled twice at once (checks run in the background): hand back the bin they were just given
  if p_from is not null then
    select c.bin into b from pipeline.bin_claims c where c.who = p_who and c.bin > p_from order by c.bin limit 1;
    if b is not null then return pipeline.bin_status(b); end if;
  end if;
  b := greatest(coalesce((select max(bin) from pipeline.cleanup_piles), 0), coalesce((select max(bin) from pipeline.bin_claims), 0)) + 1;
  insert into pipeline.bin_claims(bin, who) values (b, p_who);
  return pipeline.bin_status(b);
end $$;

-- a Book Station LIST (no sticker yet) is linked to its draft by quick_price_apply (draft_id) - the bin follows it
create or replace function pipeline.piles_bin_push() returns trigger language plpgsql as $$
begin
  if new.bin is not null and (new.bin is distinct from old.bin or new.pd is distinct from old.pd or new.draft_id is distinct from old.draft_id) then
    if new.pd is not null then
      update pipeline.drafts set bin = new.bin, bin_synced = false where upper(pd) = upper(new.pd) and bin is distinct from new.bin;
    end if;
    if new.draft_id is not null then
      update pipeline.drafts set bin = new.bin, bin_synced = false where id = new.draft_id and bin is distinct from new.bin;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists piles_bin_push on pipeline.cleanup_piles;
create trigger piles_bin_push after update of bin, pd, draft_id on pipeline.cleanup_piles for each row execute function pipeline.piles_bin_push();

-- seeded: Bin 1 Heather (Sorting page), Bin 2 Papa Duck (Book Station)
insert into pipeline.bin_claims(bin, who) values (1,'heather'),(2,'papa') on conflict do nothing;
create or replace function pipeline.bin_mine(p_who text) returns jsonb language plpgsql as $$
declare b int; s jsonb;
begin
  select c.bin into b from pipeline.bin_claims c where c.who = p_who order by c.bin desc limit 1;
  if b is null then return pipeline.bin_new(p_who); end if;
  s := pipeline.bin_status(b);
  if (s->>'n')::int >= (s->>'cap')::int then return pipeline.bin_new(p_who, b); end if;
  return s;
end $$;
