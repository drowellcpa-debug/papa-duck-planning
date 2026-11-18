-- 2026-11-18 Papa Duck: "Should we have a daily system review every morning that has a gauge for every app and big system supabase ... airtable
--   that let's me know ok or need to adjust" / "I do want it on launch pad".
-- After the 5:41 AM freeze (Launch Pad load had crept to 50-110 s on a Nano database). Every morning at 6:03 AM Pacific the edge function
-- health-check runs these database gauges plus outside checks (eBay, Etsy, Amazon, AbeBooks, Airtable, web pages, Duck Hunter) and saves
-- one row here. The Launch Pad shows the newest row as a System Health card. Any red gauge also becomes a Launch Pad to-do.
-- Gauge = {key, name, icon, status: green|yellow|red, value, fix}.

create table if not exists pipeline.health_runs (
  id bigserial primary key,
  at timestamptz not null default now(),
  overall text not null,
  gauges jsonb not null,
  ms int
);

create or replace function pipeline.health_db() returns jsonb
language plpgsql set search_path to 'pipeline', 'pg_catalog' set statement_timeout to '90s' as $f$
declare
  t0 timestamptz; lp numeric; dr numeric; g jsonb := '[]'::jsonb;
  dbsize bigint; conns int; maxc int; hit numeric;
  nfail int; failtxt text; slowtxt text; slowmax numeric;
  ntot int; nerr int;
  inv_at timestamptz; stuck int; other_late text;
  st text;
begin
  -- 1) speed: the Launch Pad and Drafts loads (the thing that froze on 11/18)
  t0 := clock_timestamp();
  perform pipeline.launch_state(), pipeline.dispatch_status(40), pipeline.week_board(), pipeline.to_ship(), pipeline.alerts_open(), pipeline.sales_board(),
          pipeline.fba_track_board(), pipeline.fba_ship_state();
  lp := round(extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp();
  perform pipeline.ui_list(), pipeline.fba_list();
  dr := round(extract(epoch from clock_timestamp() - t0) * 1000);
  st := case when greatest(lp, dr) < 3000 then 'green' when greatest(lp, dr) < 12000 then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'db_speed', 'name', 'Supabase speed', 'icon', '⚡', 'status', st,
    'value', 'Launch Pad ' || round(lp / 1000.0, 1) || ' s · Drafts ' || round(dr / 1000.0, 1) || ' s',
    'fix', case st when 'green' then '' when 'yellow' then 'Pages are getting slower - ask Claude to find the slow part before it freezes.'
                else 'Pages are very slow - the database may freeze. Ask Claude to fix it today.' end);

  -- 2) room: database size (8 GB disk) and open connections
  dbsize := pg_database_size(current_database());
  select count(*) into conns from pg_stat_activity;
  select setting::int into maxc from pg_settings where name = 'max_connections';
  st := case when dbsize < 5e9 and conns < maxc * 0.6 then 'green' when dbsize < 6.5e9 and conns < maxc * 0.85 then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'db_room', 'name', 'Supabase room', 'icon', '🗄️', 'status', st,
    'value', round(dbsize / 1e9, 1) || ' of 8 GB · ' || conns || ' of ' || maxc || ' connections',
    'fix', case st when 'green' then '' else 'Getting full - ask Claude to clear old photo copies and history.' end);

  -- 3) memory: how often data is found in memory instead of read from disk (low = the database is short on memory)
  select round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 1) into hit from pg_stat_database where datname = current_database();
  st := case when coalesce(hit, 100) >= 98 then 'green' when hit >= 94 then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'db_memory', 'name', 'Supabase memory', 'icon', '🧠', 'status', st,
    'value', coalesce(hit, 100) || '% found in memory',
    'fix', case st when 'green' then '' else 'The database is short on memory - ask Claude whether it is time for the next size up (Small).' end);

  -- 4) background jobs: failures and slow runs in the last 24 hours
  select count(*), string_agg(distinct j.jobname, ', ') into nfail, failtxt
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid where d.start_time > now() - interval '24 hours' and d.status = 'failed';
  select string_agg(jobname || ' ' || round(av) || ' s', ', ' order by av desc), max(av) into slowtxt, slowmax from (
    select j.jobname, avg(extract(epoch from d.end_time - d.start_time)) av from cron.job_run_details d join cron.job j on j.jobid = d.jobid
     where d.start_time > now() - interval '24 hours' and d.end_time is not null and j.active group by j.jobname having count(*) >= 10) x
   where av > 10;
  st := case when nfail = 0 and slowtxt is null then 'green' when nfail <= 20 and coalesce(slowmax, 0) < 30 then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'jobs', 'name', 'Background jobs', 'icon', '⚙️', 'status', st,
    'value', case when nfail = 0 and slowtxt is null then 'All ran fine in the last 24 h'
                  else concat_ws(' · ', case when nfail > 0 then nfail || ' failed (' || left(failtxt, 120) || ')' end,
                                         case when slowtxt is not null then 'slow: ' || left(slowtxt, 120) end) end,
    'fix', case st when 'green' then '' else 'Ask Claude to look at these jobs.' end);

  -- 5) cloud helpers: calls from the database to the edge functions in the last 24 hours
  select count(*), count(*) filter (where timed_out or error_msg is not null or status_code >= 500) into ntot, nerr
    from net._http_response where created > now() - interval '24 hours';
  st := case when ntot = 0 or nerr * 100.0 / ntot < 2 then 'green' when nerr * 100.0 / ntot < 10 then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'helpers', 'name', 'Cloud helpers', 'icon', '☁️', 'status', st,
    'value', ntot || ' calls · ' || nerr || ' errors (' || coalesce(round(nerr * 100.0 / nullif(ntot, 0), 1), 0) || '%)',
    'fix', case st when 'green' then '' else 'More helper calls than usual are failing - ask Claude to check the logs.' end);

  -- 6) Airtable backup into Supabase (Inventory every hour, the rest daily)
  select max(finished_at) into inv_at from backup.runs where table_id = 'tblKxgB4q7v9SPqze' and status = 'ok';
  select count(*) into stuck from backup.runs where status = 'running' and started_at < now() - interval '1 hour';
  select string_agg(distinct coalesce(r.table_name, r.table_id), ', ') into other_late from (
    select table_id, max(table_name) table_name, max(finished_at) filter (where status = 'ok') last_ok from backup.runs group by table_id) r
   where r.table_id <> 'tblKxgB4q7v9SPqze' and (r.last_ok is null or r.last_ok < now() - interval '30 hours');
  st := case when inv_at > now() - interval '3 hours' and other_late is null and stuck = 0 then 'green'
             when inv_at > now() - interval '12 hours' then 'yellow' else 'red' end;
  g := g || jsonb_build_object('key', 'airtable_backup', 'name', 'Airtable backup', 'icon', '💾', 'status', st,
    'value', 'Inventory backed up ' || coalesce(to_char(inv_at at time zone 'America/Los_Angeles', 'Mon DD HH12:MI AM'), 'never')
             || case when other_late is not null then ' · late: ' || left(other_late, 80) else '' end
             || case when stuck > 0 then ' · ' || stuck || ' stuck' else '' end,
    'fix', case st when 'green' then '' else 'The Airtable backup is behind - ask Claude to restart it.' end);
  return g;
end $f$;

-- save one run; any red gauge becomes (or updates) today's Launch Pad to-do; an all-clear closes it
create or replace function pipeline.health_save(p_gauges jsonb, p_ms int default null) returns jsonb
language plpgsql set search_path to 'pipeline', 'pg_catalog' as $f$
declare ov text; reds text; v_ref text := 'health-' || to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'); rid bigint;
begin
  ov := case when exists (select 1 from jsonb_array_elements(p_gauges) x where x->>'status' = 'red') then 'red'
             when exists (select 1 from jsonb_array_elements(p_gauges) x where x->>'status' = 'yellow') then 'yellow' else 'green' end;
  insert into pipeline.health_runs(overall, gauges, ms) values (ov, p_gauges, p_ms) returning id into rid;
  select string_agg((x->>'icon') || ' ' || (x->>'name') || ': ' || (x->>'value'), E'\n') into reds from jsonb_array_elements(p_gauges) x where x->>'status' = 'red';
  if reds is not null then
    update pipeline.todos set detail = reds, done_at = null where kind = 'claude' and pipeline.todos.ref = v_ref;
    if not found then
      insert into pipeline.todos(kind, title, detail, ref) values ('claude', '🩺 System Health: something needs fixing', reds, v_ref);
    end if;
  else
    update pipeline.todos set done_at = now(), applied = 'cleared by health check' where pipeline.todos.ref = v_ref and done_at is null;
  end if;
  delete from pipeline.health_runs where at < now() - interval '90 days';
  return jsonb_build_object('ok', true, 'id', rid, 'overall', ov);
end $f$;

-- what the Launch Pad shows: the newest run, how old it is, and the last 14 days' overall colors
create or replace function pipeline.health_board() returns jsonb
language sql stable set search_path to 'pipeline', 'pg_catalog' as $f$
  select jsonb_build_object(
    'at', r.at, 'overall', r.overall, 'gauges', r.gauges,
    'age_h', round(extract(epoch from now() - r.at) / 3600.0, 1),
    'running', exists (select 1 from pipeline.config where key = 'health_kick_at' and value::timestamptz > now() - interval '3 minutes'
                       and value::timestamptz > r.at),
    'days', (select jsonb_agg(jsonb_build_object('d', d, 'o', o) order by d) from (
      select distinct on (date(at at time zone 'America/Los_Angeles')) date(at at time zone 'America/Los_Angeles') d, overall o
        from pipeline.health_runs where at > now() - interval '14 days' order by date(at at time zone 'America/Los_Angeles'), at desc) z))
  from pipeline.health_runs r order by r.at desc limit 1
$f$;

-- "Check now" button on the Launch Pad
create or replace function pipeline.health_kick() returns jsonb
language plpgsql set search_path to 'pipeline', 'pg_catalog' as $f$
begin
  insert into pipeline.config(key, value) values ('health_kick_at', now()::text) on conflict (key) do update set value = excluded.value;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/health-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
  return jsonb_build_object('ok', true);
end $f$;

-- every morning at 6:03 AM Pacific (14:03 UTC; 7:03 AM during daylight time)
select cron.schedule('pd-health-check', '3 14 * * *', $c$select pipeline.health_kick()$c$);
