-- 2026-11-14 Papa Duck: "No vintage copy should go to amazon only barcode books"
-- PD-3681 (1912 Grosset & Dunlap, no ISBN) was matched to a modern reprint ASIN; removed via amazon-delete, alert 7337 closed.
create or replace function pipeline.has_barcode(i jsonb) returns boolean language sql immutable as $$
  select length(regexp_replace(coalesce(i->>'isbn',''),'[^0-9Xx]','','g')) in (10,12,13)
      or length(regexp_replace(coalesce(i->>'upc',''),'[^0-9]','','g')) in (12,13) $$;

create or replace function pipeline.drafts_amazon_barcode_only() returns trigger language plpgsql as $$
begin
  if not pipeline.has_barcode(new.ident) and new.amazon_on is distinct from false then
    new.amazon_on := false;
  end if;
  return new;
end $$;
drop trigger if exists drafts_amazon_barcode_only on pipeline.drafts;
create trigger drafts_amazon_barcode_only before insert or update on pipeline.drafts
  for each row execute function pipeline.drafts_amazon_barcode_only();

create or replace function pipeline.launch_amz_will(d pipeline.drafts) returns boolean language sql stable as $function$
  select pipeline.has_barcode(d.ident) and coalesce(d.amazon->>'status','') = 'ok' and d.amazon_on is distinct from false
     and (d.amazon_on is true or (coalesce(d.channel,'') <> 'fba' and coalesce(d.status,'') <> 'fba' and coalesce(d.amazon->>'fit','') ~ '^(Good|OK)'))
$function$;
