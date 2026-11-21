-- 2026-11-20 21:34 Papa Duck: "sometimes I have sets that I will scan outside but intend on putting them in my office I need a bin for these
-- that will accumulate until I scan them ... really need them moved to a special holding bin" / "can you free up 16 again".
-- Bin 900 = "Office Hold" (named in pipeline.config bin_names and on the Launch Pad / Drafts pages). Bins 900+ never set the next bin number.
insert into pipeline.config(key, value) values ('bin_names', '{"900":"Office Hold"}') on conflict (key) do update set value = excluded.value;
create or replace function pipeline.bin_new(p_who text, p_from int default null) returns jsonb language plpgsql as $$
declare b int;
begin
  perform pg_advisory_xact_lock(7342077);
  if p_from is not null then
    select c.bin into b from pipeline.bin_claims c where c.who = p_who and c.bin > p_from and c.bin < 900 order by c.bin limit 1;
    if b is not null then return pipeline.bin_status(b); end if;
  end if;
  b := greatest(coalesce((select max(bin) from pipeline.cleanup_piles where bin < 900), 0), coalesce((select max(bin) from pipeline.bin_claims where bin < 900), 0)) + 1;
  insert into pipeline.bin_claims(bin, who) values (b, p_who);
  return pipeline.bin_status(b);
end $$;
-- moved tonight: PD-0318 .. PD-332 (Americana Annual 1990-94, The Book of Popular Science vols) from bin 16 to 900. Bin 16 is empty again.

-- 21:37 "yes if you can fix it": PD-319..PD-332 were saved without the leading zero. Every PD is now stored 4-digit on the way in.
create or replace function pipeline.pd_norm(p text) returns text language sql immutable as $$
  select case when p ~* '^\s*PD-?\d{1,3}\s*$' then 'PD-' || lpad(regexp_replace(p, '\D', '', 'g'), 4, '0') else p end $$;
create or replace function pipeline.pd_norm_trg() returns trigger language plpgsql as $$
begin new.pd := pipeline.pd_norm(new.pd); return new; end $$;
-- presets first: cleanup_piles' piles_flag_push upserts a preset under the new PD
update pipeline.draft_presets set pd = pipeline.pd_norm(pd) where pd ~* '^PD-?\d{1,3}$';
update pipeline.cleanup_piles set pd = pipeline.pd_norm(pd) where pd ~* '^PD-?\d{1,3}$';
drop trigger if exists pd_norm on pipeline.cleanup_piles;
create trigger pd_norm before insert or update of pd on pipeline.cleanup_piles for each row execute function pipeline.pd_norm_trg();
drop trigger if exists pd_norm on pipeline.draft_presets;
create trigger pd_norm before insert or update of pd on pipeline.draft_presets for each row execute function pipeline.pd_norm_trg();
drop trigger if exists pd_norm on pipeline.drafts;
create trigger pd_norm before insert or update of pd on pipeline.drafts for each row execute function pipeline.pd_norm_trg();
