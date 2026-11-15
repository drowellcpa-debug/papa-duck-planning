-- 2026-11-15 Papa Duck: "I would rather it show the real price and then I choose list fast price with a selector right on the front
--   of the listing in draft before going into it". Items worker "priced to sell" -> pricing.fast; list stays the real (rule) price.
create or replace function pipeline.drafts_real_price() returns trigger language plpgsql as $$
declare real numeric; fast numeric; band numeric;
begin
  if new.pricing is null or coalesce(new.pricing->>'basis','') not like 'best price that will sell%' then return new; end if;
  real := nullif(substring(new.pricing->>'note' from '-> list \$([0-9]+\.[0-9]{2})'),'')::numeric;
  fast := (new.pricing->>'list')::numeric;
  if real is null or fast is null or real <= fast then return new; end if;
  band := case when real < 12 then 0.60 else coalesce((('{"durable":0.72,"standard":0.65,"perishable":0.58}'::jsonb)->>(new.pricing->>'band'))::numeric, 0.65) end;
  new.pricing := new.pricing || jsonb_build_object('list', real, 'real', real, 'fast', fast,
     'auto', round(round(real*0.8*2)/2,2), 'min', round(round(real*band*2)/2,2),
     'band', case when real < 12 then 'low' else coalesce(new.pricing->>'band','standard') end,
     'basis', 'average delivered price of matching listings - $0.50 (fast-sell price offered on the card)');
  return new;
end $$;
drop trigger if exists drafts_real_price on pipeline.drafts;
create trigger drafts_real_price before insert or update of pricing on pipeline.drafts for each row execute function pipeline.drafts_real_price();
