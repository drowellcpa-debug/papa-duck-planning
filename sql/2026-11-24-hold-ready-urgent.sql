-- 2026-11-24 Papa Duck: "when my vinted textbooks reach their high point list now date can you add it to the urgent todos"
-- When a held Duck Hunter textbook (hunter.holds) turns 'ready' (the weekly watch says it's time to list), a 🚨 URGENT note goes on the
-- Launch Pad. It closes by itself when he taps Listed / Drop / Keep holding on the 🦆 Holding for the season card.
create or replace function hunter.holds_ready_alert() returns trigger
language plpgsql security definer set search_path to 'hunter', 'pipeline', 'pg_catalog' as $f$
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    perform pipeline.alert_add('Duck Hunter',
      '📚 Time to list: ' || left(coalesce(new.title, 'held textbook'), 80),
      'This held textbook has reached its time to sell. ' ||
      coalesce(nullif(new.season->>'note', '') || '. ', '') ||
      'Paid $' || coalesce(to_char(new.cost, 'FM9990.00'), '?') ||
      coalesce(', list about $' || to_char(coalesce(new.list_price, new.target), 'FM9990.00'), '') ||
      coalesce(' (best month: ' || new.season_month || ')', '') ||
      '. Pull it off the hold shelf, list it, then tap Listed on the 🦆 Holding for the season card.',
      null, null, 'urgent', 'holdready:' || new.id);
  elsif tg_op = 'UPDATE' and old.status = 'ready' and new.status <> 'ready' then
    update pipeline.alerts set done_at = now() where dedupe = 'holdready:' || new.id and done_at is null;
  end if;
  return new;
end $f$;
drop trigger if exists holds_ready_alert on hunter.holds;
create trigger holds_ready_alert after insert or update of status on hunter.holds for each row execute function hunter.holds_ready_alert();

-- books already 'ready' today get their urgent note now
select pipeline.alert_add('Duck Hunter', '📚 Time to list: ' || left(coalesce(h.title, 'held textbook'), 80),
  'This held textbook has reached its time to sell. ' || coalesce(nullif(h.season->>'note', '') || '. ', '') ||
  'Paid $' || coalesce(to_char(h.cost, 'FM9990.00'), '?') || coalesce(', list about $' || to_char(coalesce(h.list_price, h.target), 'FM9990.00'), '') ||
  coalesce(' (best month: ' || h.season_month || ')', '') || '. Pull it off the hold shelf, list it, then tap Listed on the 🦆 Holding for the season card.',
  null, null, 'urgent', 'holdready:' || h.id)
from hunter.holds h where h.status = 'ready';

-- Same day fix: the 11/23 buys stored the season price as the eBay list price (scout_buys.suggested_list = target), so
-- hunter.holds_ebay_check flipped them to 'ready' right away. The eBay rule now skips a list price that equals the target
-- (abs(list_price - target) > 0.01 required). Holds 8, 11, 12, 13, 14 put back to 'holding' (their urgent notes closed by the trigger).
-- Holds 7 and 10 (Saxon Course 2, Delmar Electricity) are ready by the real eBay rule - their notes reworded to say so.
