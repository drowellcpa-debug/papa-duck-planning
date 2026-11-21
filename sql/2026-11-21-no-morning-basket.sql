-- 2026-11-21 09:42 Papa Duck: "I decided against morning baskets and instead goodwill bins and buy back only".
-- station-api still answers BASKET for some low-value books; the Book Station + Sorting Helper now show those as GOODWILL (qcNoBasket /
-- sort.html), the Morning Basket buttons are gone, and the database turns any BASKET pile into GOODWILL.
insert into pipeline.config(key, value) values ('basket_on', 'false') on conflict (key) do update set value = excluded.value;
create or replace function pipeline.piles_no_basket() returns trigger language plpgsql as $$
begin
  if new.pile = 'BASKET' and coalesce((select value from pipeline.config where key = 'basket_on'), 'true') = 'false' then
    new.pile := 'GOODWILL'; new.basket_theme := null;
    new.reason := regexp_replace(coalesce(new.reason, ''), 'Worth more in a 🧺 Morning Basket lot[^.]*\.', 'Not worth listing.');
  end if;
  return new;
end $$;
drop trigger if exists piles_no_basket on pipeline.cleanup_piles;
create trigger piles_no_basket before insert or update of pile on pipeline.cleanup_piles for each row execute function pipeline.piles_no_basket();
-- Launch Pad todos 86 (lot maker) and 91 (course kits from the basket pile) closed.
