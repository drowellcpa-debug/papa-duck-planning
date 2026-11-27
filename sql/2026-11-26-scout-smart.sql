-- 2026-11-26 night, Papa Duck "42 per book does not make sense": scout v31 SMART LOOKUPS (test mode until he OKs it).
create table if not exists pipeline.scout_search_cache (k text primary key, found jsonb not null, at timestamptz not null default now());
alter table pipeline.scout_scans add column if not exists ebay_calls int, add column if not exists smart boolean;
insert into pipeline.config(key, value) values ('scout_smart', 'off') on conflict (key) do nothing;   -- 'on' after his OK
