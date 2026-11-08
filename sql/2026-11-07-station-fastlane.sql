-- 2026-11-07: Book Station jobs were waiting ~100s when the shared pg_net queue was busy with a slow call (PD-0291 "did NOT reach Drafts").
-- Fast lane: every 2 seconds, if a Station job has been pending 2+ seconds, kick station-cloud's sweep with a direct (synchronous) call that skips the pg_net queue.
create or replace function pipeline.station_fastlane() returns void language plpgsql as $$
begin
  if not exists (select 1 from pipeline.station_jobs where status = 'pending' and created_at < now() - interval '2 seconds' and created_at > now() - interval '10 minutes') then return; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');
  perform extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/station-cloud',
    array[extensions.http_header('x-backup-secret', (select value from backup.config where key = 'cron_secret'))],
    'application/json', '{"sweep":true}')::extensions.http_request);
exception when others then null;
end $$;
select cron.schedule('pd-station-fastlane', '2 seconds', 'select pipeline.station_fastlane()');
