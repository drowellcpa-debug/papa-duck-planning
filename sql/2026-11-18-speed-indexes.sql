-- 2026-11-18 Papa Duck: database froze at 5:41 AM ("could not connect to supabase", "dig deeper another way").
-- Cause: pipeline.week_board() (Launch Pad + week-tick every minute) took 85 s. pd_bin() matches upper(pd) and week_lb()
-- matches Airtable "Tracking Number" - neither had an index, so every book read whole tables, hundreds of times per load.
-- These indexes only speed up lookups; no data changes.
create index if not exists drafts_upper_pd_idx on pipeline.drafts (upper(pd), id desc);
create index if not exists cleanup_piles_upper_pd_idx on pipeline.cleanup_piles (upper(pd), id desc);
create index if not exists airtable_records_tracking_idx on backup.airtable_records ((fields->>'Tracking Number')) where table_id = 'tblKxgB4q7v9SPqze';
analyze pipeline.drafts; analyze pipeline.cleanup_piles; analyze backup.airtable_records;

-- Also applied 2026-11-18: week_board() reads a cached listed-ISBN count (pipeline.config listed_isbn_count) instead of scanning
-- every Airtable record on each Launch Pad load (45-87 s). Refreshed every 3 h:
--   pipeline.listed_isbn_refresh()  +  cron 'pd-listed-isbn-count' '33 */3 * * *'
-- Paused 2026-11-18 (Papa Duck "yes pause"): cron pd-week-tick (38) and pd-buyback-check (40).
-- 07:22 PT: Papa Duck upgraded compute Nano -> Micro (same price on Pro). Launch Pad full load: 53 s -> 0.3 s.
-- Back on: pd-week-tick (38) every minute (0.8 s a run); pd-buyback-check (40) now every 10 min (was 2; 12 s a run).
-- select cron.alter_job(38, active := true); select cron.alter_job(40, schedule := '*/10 * * * *', active := true);
