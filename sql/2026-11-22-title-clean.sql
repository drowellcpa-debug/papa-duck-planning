-- 2026-11-22 Papa Duck ("yes" - check the 31 old books' store titles and fix any that mention a quantity).
-- Edge function title-clean {pd}: reads the LIVE eBay / Etsy / AbeBooks titles, strip_batch_words(t, keep_sets=true), sends back only changed ones.
-- Queue + cron 'pd-title-clean' (every minute, one book at a time). Remove the cron when the queue is done.
create table if not exists pipeline.title_clean_q (pd text primary key, status text not null default 'queued', req bigint, result jsonb, sent_at timestamptz, done_at timestamptz);
create or replace function pipeline.title_clean_tick() returns jsonb language plpgsql set search_path to 'pipeline','pg_catalog' as $$
declare r record; nxt text; rid bigint;
begin
  for r in select q.pd, q.req, h.content, h.status_code from pipeline.title_clean_q q left join net._http_response h on h.id = q.req where q.status = 'sent' loop
    if r.status_code is not null then
      update pipeline.title_clean_q set status = 'done', result = case when r.content ~ '^\s*\{' then r.content::jsonb else jsonb_build_object('raw', left(r.content, 300)) end, done_at = now() where pd = r.pd;
    elsif (select sent_at from pipeline.title_clean_q where pd = r.pd) < now() - interval '4 minutes' then
      update pipeline.title_clean_q set status = 'timeout', done_at = now() where pd = r.pd;
    end if;
  end loop;
  if exists (select 1 from pipeline.title_clean_q where status = 'sent') then return jsonb_build_object('busy', true); end if;
  select pd into nxt from pipeline.title_clean_q where status = 'queued' order by pd limit 1;
  if nxt is null then return jsonb_build_object('done', true); end if;
  select net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/title-clean',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := jsonb_build_object('pd', nxt), timeout_milliseconds := 180000) into rid;
  update pipeline.title_clean_q set status = 'sent', req = rid, sent_at = now() where pd = nxt;
  return jsonb_build_object('sent', nxt);
end $$;
-- queued: PD-0009 0010 0011 0013 0014 0015 0016 0017 0018 0019 0020 0026 0030 0038 0039 0044 0046 0119 0121 0123 0139 1038 1039 2162 2266 2268 2273 2275 2276 2277 2278
-- select cron.schedule('pd-title-clean', '* * * * *', 'select pipeline.title_clean_tick()');
