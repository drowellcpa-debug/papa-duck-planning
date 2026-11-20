-- 2026-11-19 Papa Duck: "base the profit on the average high price during the three years when it sells at the highest" /
--   "track when i buy them and watch the real prices weekly to let me know when to list them. I will not list them until the prices
--   reaches the good time for profit". duck-hunter v8/v8b (seasonOf + watchHolds) fills this; Launch Pad card 🦆 Holding for the season.
create table if not exists hunter.holds (
  id bigserial primary key, buy_id bigint unique, isbn text, asin text, title text, cost numeric,
  target numeric, season_month text, best_store text, status text not null default 'holding',   -- holding | ready | listed | dropped
  now_price numeric, checked_at timestamptz, ready_at timestamptz, season jsonb, history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), list_price numeric);

-- eBay already pays more than Amazon's season high -> list now (unless he tapped Keep holding)
create or replace function hunter.holds_ebay_check() returns trigger
language plpgsql set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
begin
  if new.list_price is null and new.buy_id is not null then
    select suggested_list into new.list_price from pipeline.scout_buys where id = new.buy_id;
  end if;
  if new.status = 'holding' and new.list_price is not null and coalesce(new.season->>'keep', '') <> 'true'
     and (new.target is null or new.list_price >= new.target * 0.95) then
    new.status := 'ready'; new.ready_at := coalesce(new.ready_at, now());
    new.season := coalesce(new.season, '{}'::jsonb) || jsonb_build_object('note',
      'eBay already pays $' || to_char(new.list_price, 'FM9990.00') ||
      case when new.target is not null then ' - more than Amazon''s season high ($' || to_char(new.target, 'FM9990.00') || ')' else '' end || '. List it now on eBay');
  end if;
  return new;
end $f$;
drop trigger if exists holds_ebay_check on hunter.holds;
create trigger holds_ebay_check before insert or update on hunter.holds for each row execute function hunter.holds_ebay_check();

create or replace function pipeline.hold_board() returns jsonb
language sql stable security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'title', left(h.title, 70), 'isbn', h.isbn, 'cost', h.cost, 'target', h.target,
              'month', h.season_month, 'status', h.status, 'now', h.now_price, 'checked', h.checked_at, 'ready_at', h.ready_at,
              'bought', h.created_at, 'store', h.best_store, 'note', h.season->>'note')
            order by (h.status = 'ready') desc, h.created_at) from hunter.holds h
         where h.status in ('holding', 'ready') or (h.status in ('listed','dropped') and h.ready_at > now() - interval '2 days')), '[]'::jsonb),
    'last_check', (select max(checked_at) from hunter.holds))
$f$;

create or replace function pipeline.hold_mark(p_id bigint, p_status text) returns jsonb
language plpgsql security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
begin
  if p_status not in ('listed', 'dropped', 'holding') then return jsonb_build_object('ok', false, 'error', 'bad status'); end if;
  update hunter.holds set status = p_status, ready_at = case when p_status = 'holding' then null else coalesce(ready_at, now()) end,
         season = case when p_status = 'holding' then coalesce(season, '{}'::jsonb) || '{"keep":"true"}'::jsonb else season end
   where id = p_id;
  return pipeline.hold_board();
end $f$;

create or replace function pipeline.hold_check() returns jsonb
language sql security definer set search_path to 'pipeline', 'pg_catalog' as $f$
  select jsonb_build_object('ok', true, 'req', net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/duck-hunter',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-station-pass', (select value from pipeline.config where key = 'station_passcode')),
    body := '{"action":"watch"}'::jsonb, timeout_milliseconds := 60000))
$f$;

-- every Monday 7:17 AM Pacific (cron job 81)
select cron.schedule('pd-hold-watch', '17 15 * * 1', $c$select pipeline.hold_check()$c$);

-- the Duck Hunter books already bought Nov 17-18 were added to hunter.holds by hand

-- 18:17 update: the eBay rule only runs once the weekly watch has set a target (a reset target no longer flips everything to ready)
create or replace function hunter.holds_ebay_check() returns trigger
language plpgsql set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
begin
  if new.list_price is null and new.buy_id is not null then
    select suggested_list into new.list_price from pipeline.scout_buys where id = new.buy_id;
  end if;
  if new.status = 'holding' and new.list_price is not null and new.target is not null and coalesce(new.season->>'keep', '') <> 'true'
     and new.list_price >= new.target * 0.95 then
    new.status := 'ready'; new.ready_at := coalesce(new.ready_at, now());
    new.season := coalesce(new.season, '{}'::jsonb) || jsonb_build_object('note',
      'eBay already pays $' || to_char(new.list_price, 'FM9990.00') || ' - more than Amazon''s season price ($' || to_char(new.target, 'FM9990.00') || '). List it now on eBay');
  end if;
  return new;
end $f$;
-- targets of the 6 held books were reset and re-figured with duck-hunter v16 (season price = real sold prices)
