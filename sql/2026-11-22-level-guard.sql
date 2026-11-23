-- 2026-11-22 Papa Duck: "3751 did not have the level in the description make sure all books tonight have it and in the future
--   they must disclose this - critical"
-- pipeline.level_fix(draft) works out a book's Level / Grade / Primer from what was read off the book, and returns the fixed
-- eBay title + description. Trigger drafts_level_guard applies it before every save:
--   * level found  -> "Level N" (or "Grade N" / "Primer X") is put in the eBay title and a "🎓 Level:" line at the top of Book Details
--   * level NOT found but the book belongs to a leveled series (a sibling draft has a level, or it is Latin's Not So Tough /
--     an Abeka reader) -> a Drafts warning "🎓 Level not found - check the cover"
create or replace function pipeline.level_fix(d pipeline.drafts)
returns jsonb language plpgsql stable set search_path to 'pipeline', 'pg_catalog' as $$
declare t text := coalesce(d.pricing->>'ebay_title', ''); b2 text := coalesce(d.pricing->>'b2', ''); it text := coalesce(d.ident->>'title', '');
  src text; pile text; lvl text; m text[]; chk text; series boolean := false; k int; tag text;
begin
  select c.title into pile from pipeline.cleanup_piles c where upper(c.pd) = upper(d.pd) order by c.id desc limit 1;
  src := concat_ws(' ¦ ', t, it, d.ident->>'subtitle_or_series', pile, d.pricing->>'b1', d.ident->>'edition_printing',
                   d.ident->>'special_features', d.ident->>'uncertainties');
  m := regexp_match(src, '(?i)\mlevel\s+(\d{1,2}[ab]?|[a-d])\M');
  -- not on the book's own text: take it from the description only when the description names exactly one level
  if m is null and (select count(distinct lower(x[1])) from regexp_matches(b2, '(?i)\mlevel\s+(\d{1,2}[ab]?)\M', 'g') x) = 1 then
    m := regexp_match(b2, '(?i)\mlevel\s+(\d{1,2}[ab]?)\M');
  end if;
  if m is not null then lvl := 'Level ' || case when m[1] ~ '^\d' then lower(m[1]) else upper(m[1]) end; chk := '\mlevel\s+' || m[1] || '\M';
  else
    m := regexp_match(src, '(?i)\mprimer\s+([a-d])\M');
    if m is not null then lvl := 'Primer ' || upper(m[1]); chk := '\mprimer\s+' || m[1] || '\M';
    else
      m := regexp_match(src, '(?i)\mgrade\s+(\d{1,2}[ab]?|k)\M');
      if m is null then m := regexp_match(src, '(?i)\m(\d{1,2})(?:st|nd|rd|th)\s+grade\M'); end if;
      if m is not null then lvl := 'Grade ' || case when m[1] ~ '^\d' then lower(m[1]) else upper(m[1]) end;
        chk := '(\mgrade\s+' || m[1] || '\M|\m' || regexp_replace(m[1], '[ab]$', '') || '(st|nd|rd|th)\s+grade\M)'; end if;
    end if;
  end if;
  if lvl is not null then
    if t <> '' and t !~* chk then
      if it <> '' and position(lower(regexp_replace(it, '[!?]', '', 'g')) in lower(t)) = 1 then
        tag := regexp_replace(it, '[!?]', '', 'g'); t := left(t, length(tag)) || ' ' || lvl || substr(t, length(tag) + 1);
      else t := t || ' ' || lvl; end if;
      while length(t) > 80 and position(' ' in t) > 0 loop t := regexp_replace(t, '\s+\S+$', ''); end loop;
    end if;
    if b2 <> '' and b2 !~ '🎓' then
      b2 := regexp_replace(b2, '(Book Details(?:</strong></p>|</h3>)\s*<ul[^>]*>)', '\1<li>🎓 Level: ' || lvl || '</li>');
    end if;
    return jsonb_build_object('level', lvl, 'title', t, 'b2', b2, 'warn', false);
  end if;
  series := concat_ws(' ¦ ', it, d.ident->>'subtitle_or_series', pile) ~* '(not so tough|a ?beka.*reading|reading program|primer|work-?text)'
    or (it <> '' and exists (select 1 from pipeline.drafts o where o.id <> d.id and o.ident->>'title' = it
          and o.created_at > now() - interval '60 days'
          and o.pricing->>'ebay_title' ~* '(\mlevel\s+\d|\mgrade\s+\d|\d(st|nd|rd|th)\s+grade|\mprimer\s+[a-d]\M)'));
  return jsonb_build_object('level', null, 'title', t, 'b2', b2, 'warn', series);
end $$;

create or replace function pipeline.drafts_level_guard()
returns trigger language plpgsql set search_path to 'pipeline', 'pg_catalog' as $$
declare r jsonb; warn text := '🎓 Level not found - check the cover and add the Level / Grade to the title';
begin
  if new.built_at is not null or new.pricing is null or coalesce(new.pricing->>'b2', '') = '' then return new; end if;
  r := pipeline.level_fix(new);
  if r->>'level' is not null then
    new.pricing := jsonb_set(new.pricing, '{b2}', r->'b2');
    if coalesce(r->>'title', '') <> '' then new.pricing := jsonb_set(new.pricing, '{ebay_title}', r->'title'); end if;
    if jsonb_typeof(new.flags) = 'array' then
      new.flags := coalesce((select jsonb_agg(x) from jsonb_array_elements(new.flags) x where x #>> '{}' <> warn), '[]'::jsonb);
    end if;
  elsif (r->>'warn')::boolean and not coalesce(new.flags, '[]'::jsonb) @> to_jsonb(array[warn]) then
    new.flags := coalesce(new.flags, '[]'::jsonb) || to_jsonb(array[warn]);
  end if;
  return new;
end $$;
drop trigger if exists drafts_level_guard on pipeline.drafts;
create trigger drafts_level_guard before insert or update of pricing, ident on pipeline.drafts
  for each row execute function pipeline.drafts_level_guard();

-- Blast off hard stop (patched into pipeline.launch_create right after "No books are waiting for blast off."):
--   if any book going out still has the "🎓 Level not found" warning, the Launch Pad refuses to start and names the PD numbers.
--   (Applied with a DO block that inserts this check; see migration launch_create_level_stop.)
-- Tonight's fixes 11/22: PD-3751 = Level 4 Workbook (ISBN 978-1-931842-65-5, confirmed christianbook.com); PD-3754 ISBN typo
--   978-1-931848-73-0 -> 978-1-931842-73-0 (old one fails the ISBN check digit), Level 5 added to title;
--   Abeka grades: PD-0340 Mountain Pathways Gr 6, PD-3744 Of America II Gr 6 (rainbowresource.com), PD-3745 Crossroads Gr 3 (abeka.com),
--   PD-0344/0345 Grammar & Composition III Gr 9 (christianbook.com). 33 open drafts now carry a "🎓 Level:" line.
