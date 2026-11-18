-- 2026-11-18 Papa Duck (mkruz83 bought 3 Moving Beyond the Page books and asked to combine shipping):
--   "you have api can you do this automatically fo rme" / "in the future do this for me ask and I will click do and estimate shipping".
-- Every 15 minutes the edge function ebay-combine looks for a buyer with 2+ UNPAID eBay orders, adds up the listing weights and prices
-- ONE box by USPS Media Mail (retail chart, July 12 2026). The Launch Pad shows a card; nothing goes to the buyer until he taps Send.
-- Send = AddOrder (one combined order, his shipping price) + SendInvoice (with the friendly message shown on the card).
-- If he combines in Seller Hub himself, or the buyer pays, the card closes by itself on the next look.

create table if not exists pipeline.combine_invoices (
  id bigserial primary key,
  key text unique not null,                 -- buyer + item/transaction ids, so the same group is one card
  buyer text not null, buyer_name text, zip text,
  lines jsonb not null,                     -- [{order, item, txn, sku, title, price, qty, lb, service}]
  items_total numeric not null, weight_lb numeric, ship_est numeric, service text, media_ok boolean,
  ship numeric, message text,
  status text not null default 'pending',   -- pending | sending | sent | failed | dismissed | gone
  result text, combined_order text,
  created_at timestamptz not null default now(), seen_at timestamptz not null default now(), sent_at timestamptz
);

insert into pipeline.config(key, value) values ('media_mail_retail',
  '{"effective":"2026-07-12","source":"USPS Notice 123","lb":[4.39,5.13,5.86,6.60,7.34,8.08,8.81,9.55,10.29,11.02],"add":0.74}')
  on conflict (key) do update set value = excluded.value;

-- USPS Media Mail retail price for a whole-pound weight (chart to 10 lb, then +$0.74 a pound)
create or replace function pipeline.media_mail_price(p_lb numeric) returns numeric
language sql stable set search_path to 'pipeline', 'pg_catalog' as $f$
  with c as (select value::jsonb j from pipeline.config where key = 'media_mail_retail'), w as (select greatest(1, ceil(coalesce(p_lb, 1)))::int n)
  select case when w.n <= jsonb_array_length(c.j->'lb') then (c.j->'lb'->>(w.n - 1))::numeric
              else round((c.j->'lb'->>(jsonb_array_length(c.j->'lb') - 1))::numeric + (w.n - jsonb_array_length(c.j->'lb')) * (c.j->>'add')::numeric, 2) end
  from c, w
$f$;

create or replace function pipeline.combine_list() returns jsonb
language sql stable set search_path to 'pipeline', 'pg_catalog' as $f$
  select coalesce(jsonb_agg(to_jsonb(c) - 'key' order by c.created_at), '[]'::jsonb) from pipeline.combine_invoices c
   where c.status in ('pending', 'sending', 'failed') or (c.status = 'sent' and c.sent_at > now() - interval '24 hours')
$f$;

-- his tap: send with this shipping price (the card shows the estimate; he can change it)
create or replace function pipeline.combine_send(p_id bigint, p_ship numeric) returns jsonb
language plpgsql set search_path to 'pipeline', 'pg_catalog' as $f$
declare c pipeline.combine_invoices;
begin
  select * into c from pipeline.combine_invoices where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if c.status not in ('pending', 'failed') then return jsonb_build_object('ok', false, 'error', 'already ' || c.status); end if;
  if p_ship is null or p_ship <= 0 or p_ship > 60 then return jsonb_build_object('ok', false, 'error', 'Shipping must be between $0.01 and $60'); end if;
  update pipeline.combine_invoices set status = 'sending', ship = round(p_ship, 2), result = null where id = p_id;
  perform net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/ebay-combine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', (select value from backup.config where key = 'cron_secret')),
    body := jsonb_build_object('action', 'send', 'id', p_id), timeout_milliseconds := 60000);
  return jsonb_build_object('ok', true);
end $f$;

create or replace function pipeline.combine_dismiss(p_id bigint) returns jsonb
language sql set search_path to 'pipeline', 'pg_catalog' as $f$
  update pipeline.combine_invoices set status = 'dismissed' where id = p_id and status in ('pending', 'failed', 'sent') returning jsonb_build_object('ok', true)
$f$;

-- every 15 minutes (cron job pd-ebay-combine)
select cron.schedule('pd-ebay-combine', '*/15 * * * *', $c$select net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/ebay-combine',
  headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
  body := '{"action":"scan"}'::jsonb, timeout_milliseconds := 60000)$c$);
