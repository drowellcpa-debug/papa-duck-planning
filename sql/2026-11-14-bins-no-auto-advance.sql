-- 2026-11-14 Papa Duck: "when the bin has more room it should not auto advance to new bin but keep going until I say full new bin"
-- bin_assign_pd and bin_mine no longer hand out a new bin when the count reaches bin_cap (18 is a guide only).
-- A new bin number comes only from bin_new (🆕 New bin). station-api v7v: bin_put no longer returns next; action undo erases a scan.
create or replace function pipeline.bin_assign_pd(p_pd text, p_bin integer, p_who text) returns jsonb language plpgsql as $function$
declare k text := 'PD-' || substring(upper(coalesce(p_pd,'')) from '(\d{3,5}[A-Z]?)'); n int; s jsonb;
begin
  if k is null or k = 'PD-' or p_bin is null then return jsonb_build_object('ok', false, 'error', 'need pd and bin'); end if;
  update pipeline.drafts set bin = p_bin, bin_synced = false where upper(pd) = k and bin is distinct from p_bin;
  get diagnostics n = row_count;
  if not exists (select 1 from pipeline.drafts where upper(pd) = k) then
    insert into pipeline.draft_presets(pd, bin) values (k, p_bin) on conflict (pd) do update set bin = excluded.bin, used_at = null;
  end if;
  s := pipeline.bin_status(p_bin);
  return s || jsonb_build_object('ok', true, 'updated', n);
end $function$;
create or replace function pipeline.bin_mine(p_who text) returns jsonb language plpgsql as $function$
declare b int;
begin
  select c.bin into b from pipeline.bin_claims c where c.who = p_who order by c.bin desc limit 1;
  if b is null then return pipeline.bin_new(p_who); end if;
  return pipeline.bin_status(b);
end $function$;
