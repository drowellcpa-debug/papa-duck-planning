-- 2026-11-26 Papa Duck: "Yes eBay gauge" - after eBay's daily lookup limit ran out at 4:58 PM Thanksgiving night.
-- A live 🛒 eBay lookups gauge on the Launch Pad System Health card: how many of the 5,000 daily eBay lookups (Browse API)
-- are left, refreshed every 10 minutes from eBay's own rate-limit report (Analytics API - free, does not use up lookups).
-- It also drives the scanner pause: 0 left -> pipeline.config ebay_out_until = eBay's reset time (Scout + the Goodwill re-check wait);
-- lookups back -> the pause is cleared.

create or replace function pipeline.ebay_quota_refresh()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pipeline', 'pg_catalog'
as $function$
declare k jsonb; r extensions.http_response; tok text; rate jsonb; out jsonb;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '30');
  select decrypted_secret::jsonb->'ebay' into k from vault.decrypted_secrets where name = 'papaduck_keys';
  r := extensions.http((('POST', 'https://api.ebay.com/identity/v1/oauth2/token',
    array[extensions.http_header('Authorization', 'Basic ' || replace(encode(convert_to((k->>'app_id') || ':' || (k->>'cert_id'), 'utf8'), 'base64'), E'\n', ''))],
    'application/x-www-form-urlencoded', 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'))::extensions.http_request);
  tok := (r.content::jsonb)->>'access_token';
  if tok is null then
    out := jsonb_build_object('error', 'eBay sign-in refused (' || r.status || ')', 'at', now());
  else
    r := extensions.http((('GET', 'https://api.ebay.com/developer/analytics/v1_beta/rate_limit/?api_name=browse&api_context=buy',
      array[extensions.http_header('Authorization', 'Bearer ' || tok)], null, null))::extensions.http_request);
    select rt into rate
      from jsonb_array_elements((r.content::jsonb)->'rateLimits') x, jsonb_array_elements(x->'resources') res, jsonb_array_elements(res->'rates') rt
     where res->>'name' = 'buy.browse' limit 1;
    if rate is null then out := jsonb_build_object('error', 'eBay rate report unreadable (' || r.status || ')', 'at', now());
    else out := jsonb_build_object('count', (rate->>'count')::int, 'limit', (rate->>'limit')::int,
                  'remaining', greatest((rate->>'remaining')::int, 0), 'reset', rate->>'reset', 'at', now());
    end if;
  end if;
  insert into pipeline.config(key, value) values ('ebay_quota', out::text) on conflict (key) do update set value = excluded.value;
  if out ? 'remaining' then
    if (out->>'remaining')::int <= 0 then
      insert into pipeline.config(key, value) values ('ebay_out_until', out->>'reset') on conflict (key) do update set value = excluded.value;
    else
      update pipeline.config set value = '' where key = 'ebay_out_until' and value <> '';
    end if;
  end if;
  return out;
exception when others then
  return jsonb_build_object('error', left(sqlerrm, 200));
end $function$;

-- the live gauge, added to whatever the morning health check found
create or replace function pipeline.ebay_gauge()
 returns jsonb
 language sql
 stable
 set search_path to 'pipeline', 'pg_catalog'
as $function$
  with q as (select value::jsonb j from pipeline.config where key = 'ebay_quota' and value like '{%')
  select case
    when not exists (select 1 from q) then jsonb_build_object('key','ebay_lookups','icon','🔎','name','eBay lookups today','value','Not checked yet','status','yellow','fix','Checks every 10 minutes')
    when (select j ? 'error' from q) then jsonb_build_object('key','ebay_lookups','icon','🔎','name','eBay lookups today','value',(select j->>'error' from q),'status','yellow','fix','Will try again in 10 minutes')
    else (select jsonb_build_object('key','ebay_lookups','icon','🔎','name','eBay lookups today',
      'value', to_char((j->>'remaining')::int, 'FM999,999') || ' of ' || to_char((j->>'limit')::int, 'FM999,999') || ' left · resets midnight',
      'status', case when (j->>'remaining')::int <= 0 then 'red' when (j->>'remaining')::int < 1000 then 'yellow' else 'green' end,
      'fix', case when (j->>'remaining')::int <= 0 then 'Used up until midnight - Quick checks say ⏳ Maybe later box, they get re-checked automatically'
                  when (j->>'remaining')::int < 1000 then 'Running low - when it hits 0, Quick checks say ⏳ Maybe later box'
                  else '' end) from q)
  end
$function$;

create or replace function pipeline.health_board()
 returns jsonb
 language sql
 stable
 set search_path to 'pipeline', 'pg_catalog'
as $function$
  select jsonb_build_object(
    'at', r.at, 'overall', r.overall,
    -- 2026-11-26: + the live eBay lookups gauge (pipeline.ebay_gauge, refreshed every 10 minutes)
    'gauges', coalesce((select jsonb_agg(g) from jsonb_array_elements(r.gauges) g where g->>'key' <> 'ebay_lookups'), '[]'::jsonb) || jsonb_build_array(pipeline.ebay_gauge()),
    'age_h', round(extract(epoch from now() - r.at) / 3600.0, 1),
    'running', exists (select 1 from pipeline.config where key = 'health_kick_at' and value::timestamptz > now() - interval '3 minutes'
                       and value::timestamptz > r.at),
    'days', (select jsonb_agg(jsonb_build_object('d', d, 'o', o) order by d) from (
      select distinct on (date(at at time zone 'America/Los_Angeles')) date(at at time zone 'America/Los_Angeles') d, overall o
        from pipeline.health_runs where at > now() - interval '14 days' order by date(at at time zone 'America/Los_Angeles'), at desc) z))
  from pipeline.health_runs r order by r.at desc limit 1
$function$;

select cron.schedule('pd-ebay-quota', '*/10 * * * *', 'select pipeline.ebay_quota_refresh()');
