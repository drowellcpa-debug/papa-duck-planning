-- 2026-11-17 Papa Duck: "abe books you could not set the count down, we have already figured out a way to do this, please make this automatic".
-- abe_qty_after_sale no longer stops at "no listing number": it always calls abe-qty (v5), which finds the listing in his AbeBooks store
-- by PD number / title itself, lowers the count, and only posts a Launch Pad card if it truly could not.
create or replace function pipeline.abe_qty_after_sale() returns trigger language plpgsql security definer as $$
declare n int; v_lid text; v_pd text;
begin
  if coalesce(new.info->'st'->>'abe','') !~ '^kept:\d+$' then return new; end if;
  n := substring(new.info->'st'->>'abe' from 'kept:(\d+)')::int;
  v_pd := new.info->>'pd';
  select l.ref into v_lid from audit.live l where l.store = 'AbeBooks' and l.pd = v_pd and coalesce(l.ref,'') <> '' limit 1;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/abe-qty',
    headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body := jsonb_build_object('pd', v_pd, 'lid', coalesce(v_lid, ''), 'qty', n, 'title', new.info->>'title', 'alert', true), timeout_milliseconds := 120000);
  return new;
end $$;
