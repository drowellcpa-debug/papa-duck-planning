-- Change a draft's bin from the Drafts page (works with or without a PD number yet).
create or replace function pipeline.draft_bin_set(p_id bigint, p_bin integer, p_who text)
returns jsonb language plpgsql as $$
declare v_pd text; n int;
begin
  if p_id is null or p_bin is null or p_bin < 1 or p_bin > 999 then
    return jsonb_build_object('ok', false, 'error', 'pick Office Hold or a bin number');
  end if;
  update pipeline.drafts set bin = p_bin, bin_synced = false
   where id = p_id and bin is distinct from p_bin returning pd into v_pd;
  get diagnostics n = row_count;
  if not exists (select 1 from pipeline.drafts where id = p_id) then
    return jsonb_build_object('ok', false, 'error', 'draft not found');
  end if;
  return pipeline.bin_status(p_bin) || jsonb_build_object('ok', true, 'updated', n, 'bin', p_bin, 'who', p_who);
end $$;
