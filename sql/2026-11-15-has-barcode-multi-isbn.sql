-- 2026-11-15 has_barcode v2: the old check counted ALL digits, so "978-0-570-03113-0 / 0-570-03113-3" (two ISBNs) failed.
-- Now: any single 10- or 13-digit ISBN (or 12/13-digit UPC) anywhere in the field passes.
create or replace function pipeline.has_barcode(i jsonb) returns boolean language sql immutable as $$
  select regexp_replace(regexp_replace(coalesce(i->>'isbn',''),'ISBN[- ]?1[03]','','gi'),'[- ]','','g') ~ '(^|[^0-9])(97[89][0-9]{10}|[0-9]{9}[0-9Xx])([^0-9]|$)'
      or regexp_replace(coalesce(i->>'upc',''),'[- ]','','g') ~ '(^|[^0-9])([0-9]{12,13})([^0-9]|$)' $$;
