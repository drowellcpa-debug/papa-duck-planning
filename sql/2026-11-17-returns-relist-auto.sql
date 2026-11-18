-- 2026-11-17 Papa Duck: returned PD-3190 was skipped by the nightly blast off ("yes make it automatic please").
-- Cause: auto_clear_built() marks a Sent draft as done when its Airtable Inventory record says Listed or Sold -
--   a RETURNED book still says Sold, so it never went out.
-- Fix: a draft flagged answers.relist (a returned book going back up) is never auto-cleared, and
--   pipeline.relist_return(pd, price, bin) puts a returned book back in Sent with that flag, so it rides the next blast off.
create or replace function pipeline.auto_clear_built()
returns jsonb language plpgsql set search_path to 'pipeline', 'backup', 'pg_catalog' as $function$
declare n int;
begin
  update pipeline.drafts d set built_at = now(), archived_at = coalesce(d.archived_at, now())
   where d.status = 'sent' and d.built_at is null and d.pd is not null
     and coalesce(d.answers->>'relist', '') = ''          -- 2026-11-17: returned books going back up are never skipped
     and exists (select 1 from backup.airtable_records r
                  where r.table_id = 'tblKxgB4q7v9SPqze'
                    and r.fields->>'Tracking Number' = d.pd
                    and r.fields->>'Status' in ('Listed','Sold'));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'cleared', n);
end $function$;

create or replace function pipeline.relist_return(p_pd text, p_price numeric default null, p_bin int default null)
returns jsonb language plpgsql set search_path to 'pipeline', 'pg_catalog' as $function$
declare d pipeline.drafts;
begin
  select * into d from pipeline.drafts where pd = p_pd order by id desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'No draft for ' || p_pd); end if;
  update pipeline.drafts set status = 'sent', built_at = null, archived_at = null,
    price_override = coalesce(p_price, price_override), bin = coalesce(p_bin, bin),
    answers = coalesce(answers, '{}'::jsonb) || jsonb_build_object('relist', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'price_ok', 'keep')
   where id = d.id;
  return jsonb_build_object('ok', true, 'pd', p_pd, 'draft_id', d.id, 'note', 'Goes out in the next blast off');
end $function$;
