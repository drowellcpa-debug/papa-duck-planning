-- 2026-11-10: PD-3098 (one of the 88 sent tonight) was switched off by Amazon for a high pricing error - it went up at the eBay price
-- ($52.99) and amazon-price had skipped it ("not buyable (DISCOVERABLE)") and then would not look again for 12 h.
-- Fixed: amazon-price re-run for job 114 (PD-3098 reinstated at $11.99). Trigger amazon_prices_skip_retry stores "not buyable" skip rows
-- as dry so the next 2-hourly run (cron job 36) checks them again.
create or replace function pipeline.amazon_prices_skip_retry() returns trigger language plpgsql as $$
begin
  if new.state = 'skip' and coalesce(new.note,'') like 'not buyable%' then new.dry := true; end if;
  return new;
end $$;
create trigger amazon_prices_skip_retry before insert on pipeline.amazon_prices for each row execute function pipeline.amazon_prices_skip_retry();
