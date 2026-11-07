-- 2026-11-06: Papa Duck does not sell pins or jewelry. Non-book items whose title/type looks like a pin or jewelry
-- get a 🚨 SKIP flag and are never priced (pricing cleared, price_stale/item_stale false). Applied as migration drafts_skip_pins_jewelry.
create or replace function pipeline.is_pin_or_jewelry(t text) returns boolean language sql immutable as $$
  select coalesce(t,'') ~* '(jewelry|jewellery|brooch|necklace|pendant|earrings?\M|bracelet|bangle|cuff ?links?|tie (clip|tack|bar)|lapel|pinback|\mpins?\M|hat pin|enamel pin|\m(gold|silver|sterling|diamond|signet|class|wedding|engagement|cocktail|costume) rings?\M|costume jewel)'
$$;
create or replace function pipeline.drafts_skip_pins_fn() returns trigger language plpgsql as $$
declare
  f text := '🚨 SKIP - pins/jewelry. Papa Duck does not sell pins or jewelry (11/6). Not priced.';
  txt text;
begin
  if coalesce(new.ident->>'kind','') <> 'item' then return new; end if;
  txt := coalesce(new.ident->>'title','') || ' ' || coalesce(new.ident->'item'->>'type','') || ' ' || coalesce(new.ident->'item'->>'line_or_pattern','');
  if not pipeline.is_pin_or_jewelry(txt) then return new; end if;
  if not coalesce(new.flags,'[]'::jsonb) @> to_jsonb(array[f]) then new.flags := coalesce(new.flags,'[]'::jsonb) || to_jsonb(array[f]); end if;
  new.pricing := null; new.priced_at := null; new.price_stale := false; new.item_stale := false;
  return new;
end $$;
create trigger drafts_skip_pins before insert or update on pipeline.drafts
for each row when (new.built_at is null) execute function pipeline.drafts_skip_pins_fn();
