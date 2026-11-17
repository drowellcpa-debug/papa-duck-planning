-- 2026-11-16 Launch Pad web 'cloud took too long' during blast off: launch_state took 7.6 s - pipeline.drafts had no index on pd.
create index if not exists drafts_pd_idx on pipeline.drafts (pd);
create index if not exists drafts_bin_idx on pipeline.drafts (bin) where bin is not null;
-- launch_state now 0.17 s.
