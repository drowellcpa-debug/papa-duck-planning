-- 2026-11-26 Papa Duck: "can you have it warn me when the tag does not match the book we have pre scanned, some of the tags fall off in the bin"
-- 1) Book Station: typing the sticker number shows what that number was pre-scanned as (pipeline.pd_prescan via drafts-api v14).
-- 2) Drafts: once the cloud reads the book, a 🏷️ Sticker check flag goes on the draft when it doesn't match the pre-scan
--    (same ISBN, or at least half the title words in common = a match), and names the book in the same bin it most likely is.
-- Dry run on 153 recent pre-scanned books: 1 flagged (PD-6007, pre-scanned as a Barbie paint book, listed as Ms. Pac-Man).
create or replace function pipeline.title_words(t text) returns text[]
language sql immutable as $f$
  select coalesce(array_agg(distinct w), '{}') from regexp_split_to_table(lower(coalesce(t,'')), '[^a-z0-9]+') w
   where length(w) >= 3 and w not in ('the','and','for','with','from','book','books','edition','paperback','hardcover','volume','vol','set','your','its','that','this')
$f$;
create or replace function pipeline.title_match(a text, b text) returns numeric
language sql immutable as $f$
  select case when cardinality(x) = 0 or cardinality(y) = 0 then null
    else greatest((select count(*) from unnest(x) w where w = any(y))::numeric / cardinality(x),
                  (select count(*) from unnest(y) w where w = any(x))::numeric / cardinality(y)) end
  from (select pipeline.title_words(a) x, pipeline.title_words(b) y) s
$f$;

create or replace function pipeline.pd_prescan(p_pd text) returns jsonb
language sql stable security definer set search_path to 'pipeline', 'pg_catalog' as $f$
  select coalesce((select jsonb_build_object('ok', true, 'found', true, 'pd', upper(c.pd), 'title', c.title, 'isbn', c.isbn, 'bin', c.bin, 'pile', c.pile)
     from pipeline.cleanup_piles c
    where upper(c.pd) = 'PD-' || lpad(regexp_replace(upper(coalesce(p_pd,'')), '\D', '', 'g'), 4, '0')
    order by c.id desc limit 1), jsonb_build_object('ok', true, 'found', false))
$f$;

create or replace function pipeline.drafts_sticker_check() returns trigger
language plpgsql security definer set search_path to 'pipeline', 'pg_catalog' as $f$
declare c record; o record; t text := coalesce(new.ident->>'title', ''); i text; ok boolean; msg text;
begin
  if new.built_at is not null or new.pd is null then return new; end if;
  new.flags := coalesce((select jsonb_agg(f) from jsonb_array_elements(coalesce(new.flags, '[]'::jsonb)) f where f::text !~ '🏷️ Sticker check'), '[]'::jsonb);
  if t = '' then return new; end if;
  select * into c from pipeline.cleanup_piles where upper(pd) = upper(new.pd) order by id desc limit 1;
  if not found or coalesce(c.title, '') = '' then return new; end if;
  i := pipeline.isbn13(coalesce(new.ident->>'isbn', ''));
  ok := (coalesce(i, '') <> '' and i = pipeline.isbn13(coalesce(c.isbn, ''))) or coalesce(pipeline.title_match(c.title, t || ' ' || coalesce(new.ident->>'subtitle_or_series', '')), 1) >= 0.5;
  if ok then return new; end if;
  -- which book in the same bin does it look like? (one whose sticker hasn't been used for a draft yet)
  select p.pd, p.title into o from pipeline.cleanup_piles p
   where p.bin is not distinct from c.bin and p.pd is not null and upper(p.pd) <> upper(new.pd)
     and not exists (select 1 from pipeline.drafts d where upper(d.pd) = upper(p.pd) and d.id <> new.id)
     and ((coalesce(i, '') <> '' and i = pipeline.isbn13(coalesce(p.isbn, ''))) or coalesce(pipeline.title_match(p.title, t), 0) >= 0.5)
   order by (coalesce(i, '') <> '' and i = pipeline.isbn13(coalesce(p.isbn, ''))) desc, pipeline.title_match(p.title, t) desc nulls last limit 1;
  msg := '🏷️ Sticker check: ' || upper(new.pd) || ' was pre-scanned as "' || left(c.title, 60) || '", but this book reads as "' || left(t, 60) ||
    '". The tag may have fallen off' || case when o.pd is not null then ' - it looks like ' || upper(o.pd) || ' "' || left(o.title, 60) || '"' ||
    coalesce(' in Bin ' || c.bin, '') else '' end || '. Check the sticker before you send it.';
  new.flags := new.flags || to_jsonb(array[msg]);
  return new;
end $f$;
drop trigger if exists drafts_sticker_check on pipeline.drafts;
create trigger drafts_sticker_check before insert or update of ident, pd on pipeline.drafts
  for each row execute function pipeline.drafts_sticker_check();
