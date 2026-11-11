-- 2026-11-11 Supabase "running out of Disk IO budget" -> Papa Duck "Ok free it is".
-- cron.job_run_details was ~770 MB / 673k rows (the 2 s and 5 s fast lanes log every run). Keep 2 days.
create or replace function pipeline.cron_log_trim() returns int language plpgsql security definer as $$
declare n int;
begin
  delete from cron.job_run_details where runid in (select runid from cron.job_run_details where end_time < now() - interval '2 days' limit 100000);
  get diagnostics n = row_count;
  return n;
end $$;
select cron.schedule('pd-cron-log-trim', '7 * * * *', 'select pipeline.cron_log_trim()');
-- first run deleted 100,000; ~510k old rows left -> cleared by the hourly job in ~6 hours, then it just keeps 2 days.
