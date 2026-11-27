-- 2026-11-26 night, Papa Duck: "My biggest concern is in the draft I want the prices to be accurate".
-- While eBay's daily lookups are used up (pipeline.config ebay_out_until in the future), the Drafts pricers WAIT instead of pricing
-- without eBay: the book stays "pricing..." (price_stale) and is priced as soon as eBay is back (the eBay gauge clears the pause).
create or replace function pipeline.ebay_ok()
 returns boolean
 language sql
 stable
as $function$
  select not exists (select 1 from pipeline.config where key = 'ebay_out_until' and value <> '' and now() < value::timestamptz)
$function$;

select cron.alter_job(10, command := $c$ select pipeline.run_price_worker() where pipeline.ebay_ok() and exists (
  select 1 from pipeline.drafts where status in ('drafted','sent') and built_at is null and price_stale and price_attempts < 3 and ident is not null and coalesce(ident->>'title','') <> '')$c$);

select cron.alter_job(42, command := $c$
  -- 2026-11-06 Papa Duck "it is taking a long time for pricing": up to 3 items worked at once when several are waiting (jobs are claimed with skip locked, so no double work)
  -- 2026-11-26: waits while eBay's daily lookups are used up (pipeline.ebay_ok)
  select pipeline.items_release_stuck();
  select net.http_post(url:='https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/items-worker',
    headers:=jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
    body:='{}'::jsonb, timeout_milliseconds:=150000)
  from generate_series(1, least(3, (select count(*) from pipeline.drafts where built_at is null and (ident->>'item_check' = 'pending' or (ident->>'kind' = 'item' and item_stale and price_attempts < 3))))::int)
  where pipeline.ebay_ok();
$c$);
