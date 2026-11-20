-- 2026-11-20 07:30 Papa Duck: "the gauge is still yellow ... is this from the other day" / "yes please fix".
-- System Health "Background jobs" was yellow: pd-fba-issue-watch 27 s every 15 min, pd-buyback-check 13 s every 10 min (both mostly waiting on
-- Amazon / BookScouter, holding a database connection).
alter table pipeline.fba_items add column if not exists issue_checked_at timestamptz;
-- pipeline.fba_issue_check(): the item loop now reads
--   ... and (i.status = 'error' or i.issue_checked_at is null or i.issue_checked_at < now() - interval '2 hours')
--   order by i.issue_checked_at nulls first, i.pd limit 20 loop
--     update pipeline.fba_items set issue_checked_at = now() where id = r.id;
-- (each FBA book asked about once every 2 hours, 20 per run, never-checked books first). Test run: 8.6 s (was 27 s).
select cron.alter_job(40, command := 'select pipeline.buyback_run(10)');   -- was 25 per run; 1,440 quotes a day still covers every listed book in ~2 days
