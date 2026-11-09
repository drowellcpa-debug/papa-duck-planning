-- 2026-11-08: eBay sends fast lane (job 106 waited 100 s behind a slow pg_net call). Cron pd-send-fastlane every 5 s (cron job 70).
create or replace function pipeline.send_fastlane() returns void language plpgsql as $$
begin
  if not exists (select 1 from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
                  where j.status = 'running' and j.channel = 'ebay' and i.state = 'queued' and i.updated_at < now() - interval '5 seconds'
                    and i.updated_at > now() - interval '30 minutes'
                    and not exists (select 1 from pipeline.send_items k where k.job_id = i.job_id and k.claimed_at > now() - interval '10 seconds')) then return; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '4000');
  perform extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/send-worker?action=kick',
    array[extensions.http_header('x-backup-secret', (select value from backup.config where key = 'cron_secret'))],
    'application/json', '{}')::extensions.http_request);
exception when others then null;
end $$;
select cron.schedule('pd-send-fastlane', '5 seconds', 'select pipeline.send_fastlane()');
